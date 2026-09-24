"""Pinned checkpoint manifests: the exact files and SHA-256 digests a revision must have."""

import hashlib
import json
import re
from dataclasses import dataclass
from pathlib import Path, PurePosixPath

_REVISION = re.compile(r"^[0-9a-f]{40}$")
_SHA256 = re.compile(r"^[0-9a-f]{64}$")
_CHUNK = 8 * 1024 * 1024


class ManifestError(Exception):
    """The manifest file itself is malformed."""


class ManifestMismatch(Exception):
    """Checkpoint files on disk differ from the pinned manifest."""


@dataclass(frozen=True)
class ManifestFile:
    """One pinned file: its byte size and SHA-256 digest."""

    path: str
    size: int
    sha256: str


@dataclass(frozen=True)
class Manifest:
    """One pinned checkpoint revision and the digest of the manifest bytes."""

    repo: str
    revision: str
    checkpoint_context: int
    files: tuple[ManifestFile, ...]
    sha256: str

    @property
    def model_id(self) -> str:
        """The artifact id every response reports: `repo@revision`."""
        return f"{self.repo}@{self.revision}"


def load_manifest(path: Path) -> Manifest:
    """Read and validate one manifest. The digest covers the exact file bytes."""
    raw = Path(path).read_bytes()
    digest = hashlib.sha256(raw).hexdigest()
    try:
        data = json.loads(raw)
    except ValueError as error:
        raise ManifestError(f"manifest {path} is not valid JSON: {error}") from error
    if not isinstance(data, dict):
        raise ManifestError(f"manifest {path} is not a JSON object")
    repo, revision, context, files = (
        data.get("repo"),
        data.get("revision"),
        data.get("checkpointContext"),
        data.get("files"),
    )
    if not isinstance(repo, str) or "/" not in repo:
        raise ManifestError(f"manifest {path} has no owner/name repo")
    if not isinstance(revision, str) or not _REVISION.match(revision):
        raise ManifestError(f"manifest {path} revision must be a 40-character commit sha")
    if context not in (512, 1024):
        raise ManifestError(f"manifest {path} checkpointContext must be 512 or 1024")
    if not isinstance(files, dict) or not files:
        raise ManifestError(f"manifest {path} lists no files")
    entries = []
    for name, entry in sorted(files.items()):
        part = PurePosixPath(name)
        if part.is_absolute() or ".." in part.parts or not name:
            raise ManifestError(f"manifest {path} file {name!r} is not a relative path")
        if not isinstance(entry, dict):
            raise ManifestError(f"manifest {path} file {name!r} has no size and sha256")
        size, sha = entry.get("size"), entry.get("sha256")
        if not isinstance(size, int) or isinstance(size, bool) or size < 0:
            raise ManifestError(f"manifest {path} file {name!r} size must be a non-negative integer")
        if not isinstance(sha, str) or not _SHA256.match(sha):
            raise ManifestError(f"manifest {path} file {name!r} sha256 must be 64 lowercase hex")
        entries.append(ManifestFile(name, size, sha))
    return Manifest(repo, revision, context, tuple(entries), digest)


def file_sha256(path: Path) -> str:
    """Stream one file through SHA-256."""
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(_CHUNK), b""):
            digest.update(block)
    return digest.hexdigest()


def verify_files(manifest: Manifest, model_dir: Path) -> None:
    """Require every pinned file to exist as a regular file with its size and digest."""
    root = Path(model_dir)
    for entry in manifest.files:
        target = root / entry.path
        if target.is_symlink() or not target.is_file():
            raise ManifestMismatch(f"{entry.path} is missing or not a regular file")
        size = target.stat().st_size
        if size != entry.size:
            raise ManifestMismatch(f"{entry.path} has {size} bytes, manifest pins {entry.size}")
        actual = file_sha256(target)
        if actual != entry.sha256:
            raise ManifestMismatch(f"{entry.path} sha256 {actual} differs from manifest {entry.sha256}")
