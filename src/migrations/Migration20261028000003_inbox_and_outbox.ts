import { Migration } from "@mikro-orm/migrations";

// 02-design §4: inbox (dedup do consumidor, ADR-0015) e outbox (ADR-0014).
export class Migration20261028000003_inbox_and_outbox extends Migration {
	override async up(): Promise<void> {
		this.addSql(`
CREATE TABLE inbox_messages (
  consumer_name text NOT NULL,
  message_id    text NOT NULL,
  payload_hash  text NOT NULL,
  received_at   timestamptz NOT NULL,
  processed_at  timestamptz NULL,
  PRIMARY KEY (consumer_name, message_id)
)`);

		this.addSql(`
CREATE TABLE outbox_messages (
  id              uuid PRIMARY KEY,            -- = eventId (estável nas republicações)
  aggregate_id    text NOT NULL,
  group_key       text NOT NULL,               -- SQS MessageGroupId (= walletId)
  event_type      text NOT NULL,
  payload         jsonb NOT NULL,              -- envelope serializado (dinheiro como string)
  occurred_at     timestamptz NOT NULL,
  attempts        integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL,
  published_at    timestamptz NULL,
  failed_at       timestamptz NULL,            -- publish_failed (erro permanente)
  last_error      text NULL,
  CONSTRAINT ob_final_exclusive CHECK (published_at IS NULL OR failed_at IS NULL)
)`);
		this.addSql(
			"CREATE INDEX ob_publishable ON outbox_messages (occurred_at) WHERE published_at IS NULL AND failed_at IS NULL",
		);
	}

	// Sem triggers nestas tabelas e sem DELETE: DROP TABLE basta.
	override async down(): Promise<void> {
		this.addSql("DROP TABLE outbox_messages");
		this.addSql("DROP TABLE inbox_messages");
	}
}
