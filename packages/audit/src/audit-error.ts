/** The typed error every audit adapter raises. Dependency-free, so light modules (finding
 * confirmation, engagement findings) can use it without loading the image libraries. */
export class VisualAuditError extends Error {
  constructor(
    public code: string,
    message: string
  ) {
    super(message);
    this.name = 'VisualAuditError';
  }
}
