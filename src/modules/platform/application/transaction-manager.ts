/**
 * Port: runs `work` in one database transaction (with the lock/statement timeouts of ADR-0006).
 * Repositories join the transaction of the surrounding `run`; nested `run` joins as well.
 * Errors leave `run` already translated to the application types of `persistence-errors.ts`
 * (boundary N14); anything else is rethrown untouched.
 */
export abstract class TransactionManager {
	abstract run<T>(work: () => Promise<T>): Promise<T>;
}
