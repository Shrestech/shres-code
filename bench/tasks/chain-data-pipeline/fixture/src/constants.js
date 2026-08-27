/**
 * Pipeline transformation constants.
 * These values govern the behavior of all pipeline stages.
 * @module
 */

/** Each raw value is divided by this factor during normalization. */
export const SCALE_FACTOR = 100

/** Added to each normalized value during transformation. */
export const OFFSET = 2.5

/** Number of decimal places in the formatted output. */
export const PRECISION = 3
