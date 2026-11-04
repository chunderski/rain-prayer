-- Reference data: the versioned framework library. Global, read-only to the app role.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- One row per library release loaded by the seed (crosswalk and shared controls are versioned by it).
CREATE TABLE library_release (
  version    text PRIMARY KEY CHECK (version ~ '^\d+\.\d+\.\d+$'),
  loaded_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE framework (
  id          text PRIMARY KEY CHECK (id ~ '^[a-z][a-z0-9-]{1,40}$'),
  name        text NOT NULL,
  short_name  text NOT NULL,
  kind        text NOT NULL,
  category    text NOT NULL CHECK (category IN ('physical', 'cyber', 'hybrid')),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE framework_version (
  framework_id    text NOT NULL REFERENCES framework (id),
  version         text NOT NULL CHECK (version ~ '^\d+\.\d+\.\d+$'),
  name            text NOT NULL,
  short_name      text NOT NULL,
  kind            text NOT NULL,
  category        text NOT NULL,
  description     text NOT NULL,
  publisher       text NOT NULL,
  source_edition  text NOT NULL,
  sources         jsonb NOT NULL,
  levels          jsonb NOT NULL,
  published_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (framework_id, version)
);

CREATE TABLE requirement (
  framework_id  text NOT NULL,
  version       text NOT NULL,
  code          text NOT NULL,
  parent_code   text,
  level         text NOT NULL,
  title         text NOT NULL,
  text          text NOT NULL,
  citation      jsonb NOT NULL,
  status        text NOT NULL CHECK (status IN ('verified', 'needs_review')),
  scale         jsonb,
  sort_order    integer NOT NULL,
  PRIMARY KEY (framework_id, version, code),
  FOREIGN KEY (framework_id, version) REFERENCES framework_version (framework_id, version) ON DELETE CASCADE
);

CREATE TABLE shared_control (
  id                text NOT NULL CHECK (id ~ '^SC-[A-Z]{2,5}-\d{3}$'),
  library_version   text NOT NULL REFERENCES library_release (version),
  domain            text NOT NULL,
  title             text NOT NULL,
  objective         text NOT NULL,
  asset_types       text[] NOT NULL DEFAULT '{}',
  default_severity  text NOT NULL CHECK (default_severity IN ('info', 'low', 'medium', 'high', 'critical')),
  evidence          jsonb NOT NULL,
  "references"      jsonb NOT NULL DEFAULT '[]',
  status            text NOT NULL CHECK (status IN ('draft', 'needs_review', 'approved')),
  PRIMARY KEY (id, library_version)
);
CREATE INDEX shared_control_domain_idx ON shared_control (library_version, domain);

CREATE TABLE question (
  id                   text NOT NULL,
  library_version      text NOT NULL,
  shared_control_id    text NOT NULL,
  text                 text NOT NULL,
  answer_type          text NOT NULL,
  compliant_answer     text,
  options              jsonb,
  scale                jsonb,
  unit                 text,
  guidance             text NOT NULL,
  photo_on_deficiency  boolean NOT NULL DEFAULT false,
  sort_order           integer NOT NULL,
  PRIMARY KEY (id, library_version),
  FOREIGN KEY (shared_control_id, library_version) REFERENCES shared_control (id, library_version) ON DELETE CASCADE
);
CREATE INDEX question_control_idx ON question (library_version, shared_control_id);

CREATE TABLE crosswalk (
  library_version    text NOT NULL REFERENCES library_release (version),
  shared_control_id  text NOT NULL,
  framework_id       text NOT NULL,
  version            text NOT NULL,
  requirement_code   text NOT NULL,
  relationship       text NOT NULL CHECK (relationship IN ('satisfies', 'supports', 'informs')),
  rationale          text NOT NULL,
  PRIMARY KEY (library_version, shared_control_id, framework_id, version, requirement_code),
  FOREIGN KEY (shared_control_id, library_version) REFERENCES shared_control (id, library_version) ON DELETE CASCADE,
  FOREIGN KEY (framework_id, version, requirement_code) REFERENCES requirement (framework_id, version, code) ON DELETE CASCADE
);
CREATE INDEX crosswalk_framework_idx ON crosswalk (framework_id, version, library_version);

-- Reference tables: the app role may read, never write.
GRANT USAGE ON SCHEMA public TO sentinel_app;
GRANT SELECT ON library_release, framework, framework_version, requirement, shared_control, question, crosswalk TO sentinel_app;
