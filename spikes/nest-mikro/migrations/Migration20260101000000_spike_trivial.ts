import { Migration } from "@mikro-orm/migrations";

export class Migration20260101000000_spike_trivial extends Migration {
	override async up(): Promise<void> {
		this.addSql(
			"create table spike_migrated (id int primary key, label text not null)",
		);
	}

	override async down(): Promise<void> {
		this.addSql("drop table spike_migrated");
	}
}
