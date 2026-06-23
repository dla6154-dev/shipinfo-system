DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM cron.job
    WHERE jobname = 'fetch-kma-buoy-every-5min'
  ) THEN
    PERFORM cron.unschedule(
      (
        SELECT jobid
        FROM cron.job
        WHERE jobname = 'fetch-kma-buoy-every-5min'
        ORDER BY jobid DESC
        LIMIT 1
      )
    );
  END IF;
END $$;

SELECT cron.schedule(
  'fetch-kma-buoy-every-5min',
  '*/5 * * * *',
  $job$
  SELECT net.http_post(
    url := 'https://fnpsaypaxpxyyqmrqwai.supabase.co/functions/v1/fetch-kma-buoy',
    headers := '{"Content-Type": "application/json", "Authorization": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZucHNheXBheHB4eXlxbXJxd2FpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM5OTc1NzYsImV4cCI6MjA4OTU3MzU3Nn0.yZir2n-zxnbedVdIKwpqJAnWjuwEp96jIYjOY6cNPe4"}'::jsonb,
    body := '{}'::jsonb
  ) AS request_id
  $job$
);
