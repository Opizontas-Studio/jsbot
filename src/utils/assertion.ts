export function assertIsError(error: unknown): asserts error is Error {
    if (!(error instanceof Error)) {
        throw new Error('error is not an Error type object');
    }
}
