import argparse
import json

from laya_gateway.__main__ import install, main, prepare_server, serve
from laya_gateway.manifest import file_sha256

from .conftest import StubBackend


def make_manifest(tmp_path, data=b"weights", context=512):
    model = tmp_path / "model"
    model.mkdir()
    (model / "model.bin").write_bytes(data)
    manifest = tmp_path / "manifest.json"
    manifest.write_text(json.dumps({
        "repo": "owner/name", "revision": "c" * 40, "checkpointContext": context,
        "files": {"model.bin": {"size": len(data), "sha256": file_sha256(model / "model.bin")}},
    }))
    return manifest, model


def serve_args(manifest, model):
    return argparse.Namespace(manifest=manifest, model_dir=model, dtype="float16", batch_size=4, max_request_bytes=4096, port=0)


def test_prepare_server_builds_the_readiness_record(tmp_path):
    manifest, model = make_manifest(tmp_path, context=512)
    server, readiness = prepare_server(serve_args(manifest, model), lambda d, t, b: StubBackend(max_len=512))
    try:
        assert readiness["ready"] is True and readiness["port"] == server.port
        assert readiness["model"] == "owner/name@" + "c" * 40
        assert readiness["manifestSha256"] == file_sha256(manifest)
        assert readiness["limits"]["maxSequenceTokens"] == 512
    finally:
        server.server_close()


def test_serve_exits_3_on_checkpoint_mismatch_and_4_on_load_failure(tmp_path, capsys):
    manifest, model = make_manifest(tmp_path, context=1024)
    assert serve(serve_args(manifest, model), lambda d, t, b: StubBackend(max_len=512)) == 3
    assert "checkpoint mismatch" in capsys.readouterr().err

    def broken(d, t, b):
        raise RuntimeError("metal unavailable")
    assert serve(serve_args(manifest, model), broken) == 4
    assert "model load failed: RuntimeError: metal unavailable" in capsys.readouterr().err
    (model / "model.bin").write_bytes(b"tampered")
    assert serve(serve_args(manifest, model), lambda d, t, b: StubBackend(max_len=1024)) == 3


def test_install_downloads_pinned_files_and_verifies(tmp_path, capsys):
    manifest, source = make_manifest(tmp_path)
    dest = tmp_path / "dest"
    calls = []

    def download(repo, revision, local_dir, allow_patterns):
        calls.append((repo, revision, allow_patterns))
        (dest).mkdir(parents=True, exist_ok=True)
        (dest / "model.bin").write_bytes((source / "model.bin").read_bytes())

    assert install(argparse.Namespace(manifest=manifest, dest=dest), download) == 0
    assert calls == [("owner/name", "c" * 40, ["model.bin"])]
    assert json.loads(capsys.readouterr().out)["modelDir"] == str(dest)


def test_install_removes_a_mismatched_download(tmp_path, capsys):
    manifest, _source = make_manifest(tmp_path)
    dest = tmp_path / "dest"

    def download(repo, revision, local_dir, allow_patterns):
        dest.mkdir(parents=True, exist_ok=True)
        (dest / "model.bin").write_bytes(b"poisoned")

    assert install(argparse.Namespace(manifest=manifest, dest=dest), download) == 3
    assert not dest.exists()
    assert "rejected and removed" in capsys.readouterr().err


def test_install_refuses_a_malformed_manifest(tmp_path, capsys):
    manifest = tmp_path / "manifest.json"
    manifest.write_text("{}")
    assert install(argparse.Namespace(manifest=manifest, dest=tmp_path / "d"), lambda **_: None) == 3


def test_main_requires_a_subcommand(capsys):
    try:
        main([])
    except SystemExit as exit_:
        assert exit_.code == 2
