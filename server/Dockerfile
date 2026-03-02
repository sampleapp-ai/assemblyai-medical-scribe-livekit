FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY medical_scribe.py .

CMD ["python", "medical_scribe.py", "start"]
