// Endereços da infra de teste (docker-compose.test.yml). Credenciais fictícias.
export const testInfra = {
	databaseUrl:
		process.env.TEST_DATABASE_URL ??
		"postgres://wagering:wagering@localhost:5433/wagering_test",
	sqsEndpoint: process.env.TEST_SQS_ENDPOINT ?? "http://localhost:4567",
	region: "us-east-1",
	credentials: { accessKeyId: "test", secretAccessKey: "test" },
} as const;
