FROM golang:1.22-alpine AS builder

WORKDIR /app
COPY go.mod .
COPY *.go .
RUN go build -o metrics-worker .

FROM alpine:3.20

WORKDIR /app
COPY --from=builder /app/metrics-worker .

EXPOSE 8001

CMD ["./metrics-worker"]
