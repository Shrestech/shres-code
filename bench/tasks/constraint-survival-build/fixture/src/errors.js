/**
 * Error class for inventory utility failures.
 */
export class InventoryError extends Error {
  /**
   * @param {string} message - failure reason.
   */
  constructor(message) {
    super(message)
    this.name = 'InventoryError'
  }
}
