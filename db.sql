-- WARNING: This schema is for context only and is not meant to be run.
-- Table order and constraints may not be valid for execution.
-- For the actual migration, see: /migrations/company_knowledge_vector.sql

-- ==========================================
-- USAGE TRACKING TABLES
-- ==========================================

CREATE TABLE public.operator_usage (
  id integer NOT NULL DEFAULT nextval('operator_usage_id_seq'::regclass),
  user_id text NOT NULL UNIQUE,
  replies_sent_today integer DEFAULT 0 CHECK (replies_sent_today >= 0),
  replies_sent_week integer DEFAULT 0 CHECK (replies_sent_week >= 0),
  daily_goal integer DEFAULT 10 CHECK (daily_goal > 0),
  weekly_goal integer DEFAULT 50 CHECK (weekly_goal > 0),
  last_reset_date date DEFAULT CURRENT_DATE,
  last_reset_week_date date DEFAULT CURRENT_DATE,
  updated_at timestamp with time zone DEFAULT now(),
  CONSTRAINT operator_usage_pkey PRIMARY KEY (id)
);

CREATE TABLE public.usage_history (
  id bigint NOT NULL DEFAULT nextval('usage_history_id_seq'::regclass),
  user_id text NOT NULL,
  platform text,
  tone text,
  created_at timestamp without time zone NOT NULL DEFAULT now(),
  CONSTRAINT usage_history_pkey PRIMARY KEY (id)
);

-- ==========================================
-- COMPANY KNOWLEDGE & RAG TABLES
-- ==========================================
-- Note: These tables require pgvector extension
-- Run: CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE public.companies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id text NOT NULL,
  name text NOT NULL,
  description text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE public.company_voice_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  voice_guidelines text,
  brand_tone text,
  positioning text,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  UNIQUE(company_id)
);

CREATE TABLE public.company_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  filename text NOT NULL,
  file_type text NOT NULL CHECK (file_type IN ('pdf', 'docx', 'txt', 'md', 'url')),
  file_size bigint,
  source_url text,
  status text NOT NULL DEFAULT 'processing' CHECK (status IN ('processing', 'completed', 'failed')),
  error_message text,
  total_chunks integer DEFAULT 0,
  total_tokens integer DEFAULT 0,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE public.company_chunks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  document_id uuid NOT NULL REFERENCES company_documents(id) ON DELETE CASCADE,
  content text NOT NULL,
  embedding vector(1536), -- OpenAI text-embedding-3-small dimensions
  metadata jsonb DEFAULT '{}'::jsonb,
  chunk_index integer NOT NULL,
  token_count integer,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE public.user_company_memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL,
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member')),
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  UNIQUE(user_id, company_id)
);

-- ==========================================
-- KEY INDEXES FOR PERFORMANCE
-- ==========================================

-- Vector similarity index (HNSW for fast similarity search)
CREATE INDEX idx_company_chunks_embedding ON company_chunks 
USING hnsw (embedding vector_cosine_ops)
WITH (m = 16, ef_construction = 64);

-- Multi-tenant isolation indexes
CREATE INDEX idx_company_chunks_company_id ON company_chunks(company_id);
CREATE INDEX idx_company_documents_company_id ON company_documents(company_id);
CREATE INDEX idx_companies_owner_user_id ON companies(owner_user_id);
CREATE INDEX idx_user_company_memberships_user_id ON user_company_memberships(user_id);