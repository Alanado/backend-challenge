export interface IdGenerator {
	next(): string;
}

export class Uuidv7Generator implements IdGenerator {
	next(): string {
		return Bun.randomUUIDv7();
	}
}
