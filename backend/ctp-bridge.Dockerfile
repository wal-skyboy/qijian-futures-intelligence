# Build on the same architecture as the host running the CTP front.  CTP
# native libraries are architecture-specific; use the broker/SimNow supplied
# official SDK when the host architecture is not supported by openctp-ctp.
FROM python:3.12-slim

WORKDIR /app
COPY requirements.txt requirements-ctp.txt ./
RUN pip install --no-cache-dir -r requirements-ctp.txt
COPY ctp_bridge.py ./

ENV BRIDGE_HOST=0.0.0.0
ENV BRIDGE_PORT=8787
EXPOSE 8787
CMD ["uvicorn", "ctp_bridge:app", "--host", "0.0.0.0", "--port", "8787"]
