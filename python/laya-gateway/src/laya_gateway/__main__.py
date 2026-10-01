"""Command line: `serve` one gateway, or `install` one pinned checkpoint.

Exit codes: 0 success, 2 usage, 3 manifest or checkpoint mismatch, 4 model load failure.
"""

import argparse
import json
import shutil
import signal
import sys
import threading
from pathlib import Path
from typing import Callable

from .backend import Backend, MlxLayaBackend
from .manifest import Manifest, ManifestError, ManifestMismatch, load_manifest, verify_files
from .server import GatewayServer, GatewayState

BackendFactory = Callable[[Path, str, int], Backend]


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="laya_gateway", description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    serve = commands.add_parser("serve", help="load the pinned checkpoint and serve the Shield wire")
    serve.add_argument("--manifest", type=Path, required=True)
    serve.add_argument("--model-dir", type=Path, required=True)
    serve.add_argument("--dtype", choices=("float16", "float32"), required=True)
    serve.add_argument("--batch-size", type=int, required=True)
    serve.add_argument("--max-request-bytes", type=int, required=True)
    serve.add_argument("--port", type=int, default=0)
    install = commands.add_parser("install", help="download and verify one pinned checkpoint")
    install.add_argument("--manifest", type=Path, required=True)
    install.add_argument("--dest", type=Path, required=True)
    return parser


def prepare_server(args: argparse.Namespace, factory: BackendFactory) -> tuple[GatewayServer, dict]:
    """Verify the checkpoint, load the model, bind the port, and build the readiness record."""
    manifest = load_manifest(args.manifest)
    verify_files(manifest, args.model_dir)
    backend = factory(args.model_dir, args.dtype, args.batch_size)
    if backend.max_len != manifest.checkpoint_context:
        raise ManifestMismatch(
            f"checkpoint max_len {backend.max_len} differs from pinned context {manifest.checkpoint_context}"
        )
    state = GatewayState(backend, manifest.model_id, manifest.sha256, args.max_request_bytes)
    server = GatewayServer(state, args.port)
    readiness = {
        "ready": True,
        "port": server.port,
        "model": manifest.model_id,
        "manifestSha256": manifest.sha256,
        "limits": state.limits,
    }
    return server, readiness


def serve(args: argparse.Namespace, factory: BackendFactory = MlxLayaBackend) -> int:
    try:
        server, readiness = prepare_server(args, factory)
    except (ManifestError, ManifestMismatch) as error:
        print(f"laya-gateway: checkpoint mismatch: {error}", file=sys.stderr)
        return 3
    except Exception as error:  # noqa: BLE001 -- any load failure is reported, then exit 4
        print(f"laya-gateway: model load failed: {type(error).__name__}: {error}", file=sys.stderr)
        return 4

    def stop(_signum, _frame):
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    print(json.dumps(readiness, separators=(",", ":")), flush=True)
    try:
        server.serve_forever()
    finally:
        server.server_close()
    return 0


def install(args: argparse.Namespace, download: Callable[..., object] | None = None) -> int:
    """Download exactly the pinned files at the pinned revision, then verify every digest."""
    try:
        manifest: Manifest = load_manifest(args.manifest)
    except ManifestError as error:
        print(f"laya-gateway: {error}", file=sys.stderr)
        return 3
    if download is None:
        from huggingface_hub import snapshot_download as download
    dest = Path(args.dest)
    download(
        manifest.repo,
        revision=manifest.revision,
        local_dir=str(dest),
        allow_patterns=[entry.path for entry in manifest.files],
    )
    try:
        verify_files(manifest, dest)
    except ManifestMismatch as error:
        shutil.rmtree(dest, ignore_errors=True)
        print(f"laya-gateway: downloaded checkpoint rejected and removed: {error}", file=sys.stderr)
        return 3
    print(json.dumps({"ok": True, "modelDir": str(dest), "manifestSha256": manifest.sha256}), flush=True)
    return 0


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    return serve(args) if args.command == "serve" else install(args)


if __name__ == "__main__":
    sys.exit(main())
