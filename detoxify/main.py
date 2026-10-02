import os

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel
from detoxify import Detoxify

app = FastAPI(
    title="Badword Moderation API",
    version="1.0.0"
)

# Load once when the server starts.
# Don't load the model for every request or your RAM will enter the shadow realm.
model = Detoxify("original")

API_KEY = os.getenv("BADWORD_API_KEY")

if not API_KEY:
    raise RuntimeError("BADWORD_API_KEY is not configured")


class AnalyzeRequest(BaseModel):
    text: str


@app.post("/api/v1/analyze")
async def analyze(
    request: AnalyzeRequest,
    x_api_key: str | None = Header(default=None)
):
    # API key authentication
    if x_api_key != API_KEY:
        raise HTTPException(
            status_code=401,
            detail="Invalid API key"
        )

    if not request.text:
        raise HTTPException(
            status_code=400,
            detail="Text cannot be empty"
        )

    try:
        results = model.predict(request.text)

        # Detoxify normally returns Python floats, but explicitly
        # convert them so the JSON response is always clean.
        scores = {
            key: float(value)
            for key, value in results.items()
        }

        return {
            "scores": scores
        }

    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Model inference failed: {str(e)}"
        )