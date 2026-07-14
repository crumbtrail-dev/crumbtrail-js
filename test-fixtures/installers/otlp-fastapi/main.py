# Minimal FastAPI app stub for the installer regression harness.
#
# This is an OTLP GUIDANCE fixture: Crumbtrail's wizard never mutates a non-JS
# backend. It detects the `fastapi` stack from requirements.txt and emits OTLP
# setup guidance (endpoint/protocol/compression + auth headers + session attr)
# instead of wiring code. The harness asserts that guidance; it does NOT run
# uvicorn or install Python deps.
from fastapi import FastAPI

app = FastAPI()


@app.get("/")
def read_root():
    return {"ok": True}


@app.get("/boom")
def boom():
    raise RuntimeError("boom: intentional installer-fixture error")
