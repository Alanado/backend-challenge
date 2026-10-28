import { Migration } from "@mikro-orm/migrations";

// 02-design §4 (ADR-0006, 0008, 0010). Triggers de imutabilidade chegam na migration 2.
export class Migration20261028000001_wallets_and_wager_transactions extends Migration {
	override async up(): Promise<void> {
		this.addSql(`
CREATE TABLE wallets (
  id          uuid PRIMARY KEY,
  player_id   uuid NOT NULL,
  currency    text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  balance     numeric(19,2) NOT NULL,
  version     integer NOT NULL DEFAULT 1,
  created_at  timestamptz NOT NULL,
  updated_at  timestamptz NOT NULL,
  CONSTRAINT wallets_balance_non_negative CHECK (balance >= 0),
  CONSTRAINT wallets_version_positive     CHECK (version >= 1),
  CONSTRAINT wallets_player_currency_uk   UNIQUE (player_id, currency)
)`);

		this.addSql(`
CREATE TABLE wager_transactions (
  id                                uuid PRIMARY KEY,
  provider_id                       text NOT NULL,
  external_transaction_id           text NOT NULL,
  idempotency_key                   text NOT NULL,
  payload_hash                      text NOT NULL,
  wallet_id                         uuid NOT NULL REFERENCES wallets(id),
  player_id                         uuid NOT NULL,
  round_id                          text NOT NULL,
  game_id                           text NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
  amount      numeric(19,2) NOT NULL CHECK (amount > 0),
  currency    text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  status      text NOT NULL CHECK (status IN ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
  reference_external_transaction_id text NULL,
  reference_transaction_id          uuid NULL REFERENCES wager_transactions(id),
  failure_code                      text NULL,
  observed_balance                  numeric(19,2) NULL,
  reference_attempts                integer NOT NULL DEFAULT 0,
  next_attempt_at                   timestamptz NULL,
  created_at                        timestamptz NOT NULL,
  processed_at                      timestamptz NULL,
  updated_at                        timestamptz NOT NULL,
  CONSTRAINT wt_idempotency_uk  UNIQUE (provider_id, idempotency_key),
  CONSTRAINT wt_external_id_uk  UNIQUE (provider_id, external_transaction_id),
  CONSTRAINT wt_ref_required    CHECK (kind NOT IN ('REFUND','ROLLBACK') OR reference_external_transaction_id IS NOT NULL),
  CONSTRAINT wt_ref_forbidden   CHECK (kind NOT IN ('BET','OPENING') OR reference_external_transaction_id IS NULL),
  CONSTRAINT wt_failure_code    CHECK ((status IN ('REJECTED','FAILED')) = (failure_code IS NOT NULL)),
  CONSTRAINT wt_processed_at    CHECK ((status = 'PROCESSED') = (processed_at IS NOT NULL)),
  CONSTRAINT wt_pending_ref     CHECK (status <> 'PENDING_REFERENCE' OR next_attempt_at IS NOT NULL)
)`);

		// uma reversão PROCESSED por transação referenciada (ADR-0010)
		this.addSql(`
CREATE UNIQUE INDEX wt_one_reversal_per_reference
  ON wager_transactions (reference_transaction_id)
  WHERE kind IN ('REFUND','ROLLBACK') AND status = 'PROCESSED'`);
		this.addSql(
			"CREATE INDEX wt_pending_due ON wager_transactions (next_attempt_at) WHERE status = 'PENDING_REFERENCE'",
		);
		this.addSql(
			"CREATE INDEX wt_pending_by_ref ON wager_transactions (provider_id, reference_external_transaction_id, wallet_id) WHERE status = 'PENDING_REFERENCE'",
		);
	}

	// DROP TABLE não dispara triggers de linha; esta migration não apaga linhas, então nada a desabilitar.
	override async down(): Promise<void> {
		this.addSql("DROP TABLE wager_transactions");
		this.addSql("DROP TABLE wallets");
	}
}
