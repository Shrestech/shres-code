import json
import os

import pytest

from laya_gateway.manifest import ManifestError, ManifestMismatch, file_sha256, load_manifest, verify_files


def write_manifest(tmp_path, **overrides):
    content = {"repo": "owner/name", "revision": "c" * 40, "checkpointContext": 1024, "files": {}}
    content.update(overrides)
    path = tmp_path / "manifest.json"
    path.write_text(json.dumps(content))
    return path


def pinned(tmp_path, name="model.bin", data=b"weights"):
    target = tmp_path / "model" / name
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(data)
    return {name: {"size": len(data), "sha256": file_sha256(target)}}


def test_loads_a_valid_manifest_and_digests_its_bytes(tmp_path):
    path = write_manifest(tmp_path, files=pinned(tmp_path))
    manifest = load_manifest(path)
    assert manifest.model_id == "owner/name@" + "c" * 40
    assert manifest.checkpoint_context == 1024
    assert manifest.sha256 == file_sha256(path)
    assert [entry.path for entry in manifest.files] == ["model.bin"]


@pytest.mark.parametrize(
    "overrides, message",
    [
        ({"repo": "noslash"}, "owner/name repo"),
        ({"revision": "abc"}, "40-character"),
        ({"checkpointContext": 2048}, "512 or 1024"),
        ({"files": {}}, "lists no files"),
        ({"files": {"../x": {"size": 1, "sha256": "d" * 64}}}, "relative path"),
        ({"files": {"x": {"size": -1, "sha256": "d" * 64}}}, "non-negative"),
        ({"files": {"x": {"size": 1, "sha256": "D" * 64}}}, "64 lowercase hex"),
        ({"files": {"x": "nope"}}, "no size and sha256"),
    ],
)
def test_rejects_malformed_manifests(tmp_path, overrides, message):
    with pytest.raises(ManifestError, match=message):
        load_manifest(write_manifest(tmp_path, **overrides))


def test_rejects_non_json_and_non_object(tmp_path):
    path = tmp_path / "manifest.json"
    path.write_text("{")
    with pytest.raises(ManifestError, match="not valid JSON"):
        load_manifest(path)
    path.write_text("[]")
    with pytest.raises(ManifestError, match="not a JSON object"):
        load_manifest(path)


def test_verify_accepts_matching_files(tmp_path):
    manifest = load_manifest(write_manifest(tmp_path, files=pinned(tmp_path)))
    verify_files(manifest, tmp_path / "model")


def test_verify_rejects_missing_resized_changed_and_symlinked_files(tmp_path):
    manifest = load_manifest(write_manifest(tmp_path, files=pinned(tmp_path)))
    target = tmp_path / "model" / "model.bin"
    target.write_bytes(b"weightz")
    with pytest.raises(ManifestMismatch, match="sha256"):
        verify_files(manifest, tmp_path / "model")
    target.write_bytes(b"longer weights")
    with pytest.raises(ManifestMismatch, match="bytes"):
        verify_files(manifest, tmp_path / "model")
    target.unlink()
    with pytest.raises(ManifestMismatch, match="missing"):
        verify_files(manifest, tmp_path / "model")
    real = tmp_path / "elsewhere.bin"
    real.write_bytes(b"weights")
    os.symlink(real, target)
    with pytest.raises(ManifestMismatch, match="not a regular file"):
        verify_files(manifest, tmp_path / "model")
