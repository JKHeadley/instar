# Work Queue Registry

`WorkQueueRegistry` normalizes active work. `GET /work-queue` lists ranked items and `POST /work-queue/rescore` recomputes ranking without durable writes.
