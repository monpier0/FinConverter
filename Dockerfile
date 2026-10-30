FROM python:3.12-slim

# Liberation Serif метрически совпадает с Times New Roman — нужен для титульного листа,
# git и ssh — для команды /update (когда клон репозитория смонтирован в /app)
RUN apt-get update \
    && apt-get install -y --no-install-recommends fonts-liberation git openssh-client \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app ./app
COPY webapp ./webapp

ENV PYTHONUNBUFFERED=1 DATA_DIR=/data PORT=8080
VOLUME /data
EXPOSE 8080
CMD ["python", "-m", "app.main"]
