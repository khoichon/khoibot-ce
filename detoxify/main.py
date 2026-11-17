import os
import re
import threading

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel

app = FastAPI(
    title="Badword Moderation API",
    version="1.0.0"
)

# BADWORD_MODEL picks the model. "detoxify" is the default and lighter, "textdetox" is better at chinese and japanese
# but wants more ram (sadly), and "auto" loads both and picks per message: normal latin text goes to detoxify's english
# model, which handles slang like "sick" way better, and anything written in another script goes to textdetox
MODEL_CHOICE = os.environ.get("BADWORD_MODEL", "detoxify").strip().lower()

if MODEL_CHOICE not in ("detoxify", "textdetox", "auto"):
    raise RuntimeError(f"BADWORD_MODEL must be detoxify, textdetox or auto, got: {MODEL_CHOICE}")


def load_detoxify(variant):
    from detoxify import Detoxify

    # load once when the server starts, never per request or your ram goes boom
    detox = Detoxify(variant)

    def scores(text):
        return {key: float(value) for key, value in detox.predict(text).items()}

    return scores


def load_textdetox():
    import torch
    from transformers import AutoTokenizer, AutoModelForSequenceClassification

    MODEL_NAME = "textdetox/xlmr-large-toxicity-classifier-v2"
    tokenizer = AutoTokenizer.from_pretrained(MODEL_NAME)
    model = AutoModelForSequenceClassification.from_pretrained(MODEL_NAME)
    model.eval()

    def scores(text):
        inputs = tokenizer(text, return_tensors="pt", truncation=True, max_length=512)
        with torch.no_grad():
            logits = model(**inputs).logits
        # index 0 is neutral and index 1 is toxic, this model has no other labels
        return {"toxicity": float(torch.softmax(logits, dim=-1)[0][1])}

    return scores


# any letter from greek, cyrillic, arabic, thai, chinese, japanese, korean and friends, basically anything that isnt latin
NON_LATIN = re.compile(r"[Ͱ-῿⺀-￯]")

if MODEL_CHOICE == "detoxify":
    get_scores = load_detoxify("multilingual")
elif MODEL_CHOICE == "textdetox":
    get_scores = load_textdetox()
else:
    english_scores = load_detoxify("original")
    other_scores = load_textdetox()

    def get_scores(text):
        if NON_LATIN.search(text):
            return other_scores(text)
        return english_scores(text)

print(f"badword model: {MODEL_CHOICE}")

# one message at a time so the pi's cores dont fight over the model
model_lock = threading.Lock()

API_KEY = os.environ.get("BADWORD_API_KEY")

if not API_KEY:
    raise RuntimeError("BADWORD_API_KEY is not configured")


class AnalyzeRequest(BaseModel):
    text: str


@app.post("/api/v1/analyze")
def analyze(
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
        with model_lock:
            scores = get_scores(request.text)

        return {
            "scores": scores
        }

    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Model inference failed: {str(e)}"
        )


# pictures (only when BADWORD_VISION is 1)


# the picture models are big, so they only load when you ask for them
VISION = os.environ.get("BADWORD_VISION", "0").strip() == "1"

if VISION:
    import base64
    import io

    import numpy as np
    from PIL import Image
    from transformers import pipeline

    # tells normal pictures from explicit ones, small enough for the pi
    nsfw_pipe = pipeline("image-classification", model="Falconsai/nsfw_image_detection")

    # reads the text inside pictures (memes, screenshots). if it is not installed the explicit check still works
    try:
        from rapidocr_onnxruntime import RapidOCR

        ocr_engine = RapidOCR()
    except Exception as error:
        print("OCR is not available, only the explicit check will run:", error)
        ocr_engine = None


class ImageRequest(BaseModel):
    # a jpeg or png as base64
    image: str


def read_text(picture):
    if ocr_engine is None:
        return ""
    found, _ = ocr_engine(np.array(picture))
    if not found:
        return ""
    # keep the lines the ocr is fairly sure about, junk lines only cause false alarms
    return " ".join(line[1] for line in found if float(line[2]) >= 0.6).strip()


def explicit_score(picture):
    best = 0.0
    for entry in nsfw_pipe(picture):
        if entry["label"].lower() == "nsfw":
            best = float(entry["score"])
    return best


@app.post("/api/v1/analyze-image")
def analyze_image(
    request: ImageRequest,
    x_api_key: str | None = Header(default=None)
):
    if x_api_key != API_KEY:
        raise HTTPException(status_code=401, detail="Invalid API key")

    if not VISION:
        raise HTTPException(status_code=503, detail="Picture checks are off, start the api with BADWORD_VISION=1")

    try:
        picture = Image.open(io.BytesIO(base64.b64decode(request.image))).convert("RGB")
    except Exception:
        raise HTTPException(status_code=400, detail="That is not a picture")

    try:
        with model_lock:
            nsfw = explicit_score(picture)
            text = read_text(picture)
            # a few letters is just noise, the text model would only guess
            scores = get_scores(text) if len(text) >= 3 else {}

        return {"nsfw": nsfw, "text": text, "scores": scores}

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
