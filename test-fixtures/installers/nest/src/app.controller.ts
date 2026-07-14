import { Controller, Get } from "@nestjs/common";

@Controller()
export class AppController {
  @Get()
  index(): { ok: boolean } {
    return { ok: true };
  }

  @Get("boom")
  boom(): never {
    const err = new Error("boom: intentional installer-fixture error");
    console.error(err);
    throw err;
  }
}
