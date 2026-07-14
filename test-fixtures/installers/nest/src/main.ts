import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { logger: false });
  const port = Number(process.env.PORT) || 3000;
  await app.listen(port, "127.0.0.1");
  // Machine-readable readiness line the harness can wait on.
  console.log(`NEST_READY port=${port}`);
}

void bootstrap();
