"""Loopback gateway serving local Laya typed judgments over the Shield judgment wire.

The Node provider `@shres-code/shres-code-judgment-laya` installs this package into
a uv-managed virtual environment and supervises one gateway process. The wire
contract is owned by `@shres-code/shres-code-judgment-shield`.
"""

__version__ = "0.1.0"

ENGINE = "shield"
"""Engine identity every Shield-wire response reports."""
