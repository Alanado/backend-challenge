import { Migration } from "@mikro-orm/migrations";

// 02-design §4: ledger append-only (ADR-0009) e guarda de imutabilidade de wager_transactions (ADR-0011).
export class Migration20261028000002_wallet_ledger_entries_and_triggers extends Migration {
	override async up(): Promise<void> {
		this.addSql(`
CREATE TABLE wallet_ledger_entries (
  id             uuid PRIMARY KEY,
  wallet_id      uuid NOT NULL REFERENCES wallets(id),
  transaction_id uuid NOT NULL REFERENCES wager_transactions(id),
  wallet_version integer NOT NULL,
  direction      text NOT NULL CHECK (direction IN ('DEBIT','CREDIT')),
  amount         numeric(19,2) NOT NULL CHECK (amount > 0),
  currency       text NOT NULL,
  balance_before numeric(19,2) NOT NULL CHECK (balance_before >= 0),
  balance_after  numeric(19,2) NOT NULL CHECK (balance_after >= 0),
  created_at     timestamptz NOT NULL,
  CONSTRAINT le_arithmetic CHECK (
    (direction = 'CREDIT' AND balance_after = balance_before + amount) OR
    (direction = 'DEBIT'  AND balance_after = balance_before - amount)),
  CONSTRAINT le_one_per_tx   UNIQUE (wallet_id, transaction_id),
  CONSTRAINT le_version_uk   UNIQUE (wallet_id, wallet_version)
)`);

		this.addSql(`
CREATE FUNCTION ledger_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'wallet_ledger_entries is append-only (%)', TG_OP; END $$`);
		this.addSql(`
CREATE TRIGGER ledger_no_row_change BEFORE UPDATE OR DELETE ON wallet_ledger_entries
  FOR EACH ROW EXECUTE FUNCTION ledger_append_only()`);
		this.addSql(`
CREATE TRIGGER ledger_no_truncate BEFORE TRUNCATE ON wallet_ledger_entries
  FOR EACH STATEMENT EXECUTE FUNCTION ledger_append_only()`);

		this.addSql(`
CREATE FUNCTION wager_transactions_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'wager_transactions cannot be deleted'; END IF;
  IF OLD.status IN ('PROCESSED','REJECTED','FAILED') THEN
    RAISE EXCEPTION 'terminal wager_transactions are immutable';
  END IF;
  IF (NEW.id, NEW.provider_id, NEW.external_transaction_id, NEW.idempotency_key, NEW.payload_hash,
      NEW.wallet_id, NEW.player_id, NEW.round_id, NEW.game_id, NEW.kind, NEW.amount, NEW.currency,
      NEW.reference_external_transaction_id, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.provider_id, OLD.external_transaction_id, OLD.idempotency_key, OLD.payload_hash,
      OLD.wallet_id, OLD.player_id, OLD.round_id, OLD.game_id, OLD.kind, OLD.amount, OLD.currency,
      OLD.reference_external_transaction_id, OLD.created_at) THEN
    RAISE EXCEPTION 'wager_transactions identity columns are immutable';
  END IF;
  RETURN NEW;
END $$`);
		this.addSql(`
CREATE TRIGGER wt_guard BEFORE UPDATE OR DELETE ON wager_transactions
  FOR EACH ROW EXECUTE FUNCTION wager_transactions_guard()`);
	}

	// Seguro por construção: nenhum DELETE aqui. DROP TABLE não dispara triggers de linha, então o ledger
	// e as transações terminais populados descem sem precisar de ALTER TABLE ... DISABLE TRIGGER.
	// Se um dia este down passar a apagar linhas, desabilite o trigger da tabela afetada antes, e só dela.
	override async down(): Promise<void> {
		this.addSql("DROP TRIGGER wt_guard ON wager_transactions");
		this.addSql("DROP FUNCTION wager_transactions_guard()");
		this.addSql("DROP TABLE wallet_ledger_entries");
		this.addSql("DROP FUNCTION ledger_append_only()");
	}
}
