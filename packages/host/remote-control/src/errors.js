/**
 * Typed failures for the remote-control package. Every caller-valuable
 * condition carries a stable {@link RemoteControlErrorCode} so CLI and host
 * consumers render one decision instead of string-matching messages.
 * @module @shres-code/shres-code-host-remote-control
 */
/** Typed failure carrying a stable machine-readable code. */
export class RemoteControlError extends Error {
    /** Stable code for consumer dispatch; never suffixed or localized. */
    code;
    /**
     * @param code - stable machine-readable failure code.
     * @param message - human-readable failure description.
     */
    constructor(code, message) {
        super(message);
        this.name = 'RemoteControlError';
        this.code = code;
    }
}
//# sourceMappingURL=errors.js.map