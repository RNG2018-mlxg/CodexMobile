FROM python:3.10-slim

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
ENV PIP_NO_CACHE_DIR=1
ENV MODELSCOPE_CACHE=/models
ENV HF_HOME=/models/huggingface

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg libsndfile1 git \
  && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir --index-url https://download.pytorch.org/whl/cpu \
  torch==2.5.1+cpu torchaudio==2.5.1+cpu

COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

COPY app.py /app/app.py

EXPOSE 8000

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]
