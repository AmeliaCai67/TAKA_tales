/** Keep caught values unknown until their message has been checked. */
export function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
