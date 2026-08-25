-- Runs once, on an empty data directory, as the superuser.
--
-- CREATE EXTENSION needs privileges the application role should not hold in
-- production, so this lives here rather than in a generated migration. In a
-- managed environment the equivalent is a one-time DBA step.

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Trigram search quality knob. 0.3 is the Postgres default and is too eager for
-- a corpus this large: it returns noise for short queries. Raised deliberately;
-- re-tune against the real corpus once OFF is ingested.
ALTER DATABASE nutricheck SET pg_trgm.similarity_threshold = 0.35;
