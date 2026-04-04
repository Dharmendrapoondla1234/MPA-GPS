-- ================================================================
-- MPA BigQuery Table DDL  —  run once in BigQuery console
-- Project: photons-377606    Dataset: MPA
-- ================================================================

-- 1. Company contacts (populated by intelligence pipeline after enrichment)
CREATE TABLE IF NOT EXISTS `photons-377606.MPA.MPA_Company_Contacts` (
  imo_number          STRING    NOT NULL,
  company_name        STRING,
  company_type        STRING,    -- OWNER | OPERATOR | ISM_MANAGER | SHIP_MANAGER
  email               STRING,
  email_secondary     STRING,
  phone               STRING,
  phone_secondary     STRING,
  website             STRING,
  registered_address  STRING,
  linkedin            STRING,
  confidence          FLOAT64,
  data_source         STRING,    -- equasis | website_mailto | smtp_validated | manual | gemini_ai
  last_verified_at    TIMESTAMP,
  upserted_at         TIMESTAMP DEFAULT CURRENT_TIMESTAMP()
);

-- 2. Equasis data (owner/manager names from Equasis web scraper)
CREATE TABLE IF NOT EXISTS `photons-377606.MPA.MPA_Equasis_Data` (
  imo_number          STRING    NOT NULL,
  vessel_name         STRING,
  owner_name          STRING,
  operator_name       STRING,
  ship_manager        STRING,
  ism_manager         STRING,
  registered_owner    STRING,
  flag                STRING,
  gross_tonnage       INT64,
  year_built          INT64,
  vessel_type         STRING,
  fetched_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP()
);

-- 3. Port agent contacts
CREATE TABLE IF NOT EXISTS `photons-377606.MPA.MPA_Port_Agent_Contacts` (
  port_code           STRING    NOT NULL,
  agency_company      STRING,
  agent_name          STRING,
  email               STRING,
  email_ops           STRING,
  phone               STRING,
  phone_24h           STRING,
  vhf_channel         STRING,
  website             STRING,
  vessel_type_served  STRING    DEFAULT 'ALL',
  port_context        STRING,
  confidence          FLOAT64,
  data_source         STRING,
  upserted_at         TIMESTAMP DEFAULT CURRENT_TIMESTAMP()
);

-- 4. Watchlist
CREATE TABLE IF NOT EXISTS `photons-377606.MPA.MPA_Watchlist` (
  user_id      STRING NOT NULL,
  user_email   STRING,
  imo_number   STRING NOT NULL,
  vessel_name  STRING,
  vessel_type  STRING,
  flag         STRING,
  notes        STRING,
  added_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP()
);

-- 5. Preferred ships
CREATE TABLE IF NOT EXISTS `photons-377606.MPA.MPA_Preferred_Ships` (
  user_id      STRING NOT NULL,
  imo_number   STRING NOT NULL,
  vessel_name  STRING,
  vessel_type  STRING,
  flag         STRING,
  added_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP()
);

-- 6. CRM Sellers
CREATE TABLE IF NOT EXISTS `photons-377606.MPA.MPA_CRM_Sellers` (
  id         STRING NOT NULL,
  user_id    STRING,
  name       STRING NOT NULL,
  company    STRING,
  role       STRING,
  email      STRING,
  website    STRING,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP(),
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP()
);

-- 7. CRM Buyers (global shared across sellers)
CREATE TABLE IF NOT EXISTS `photons-377606.MPA.MPA_CRM_Buyers` (
  id         STRING NOT NULL,
  name       STRING NOT NULL,
  company    STRING,
  role       STRING,
  email      STRING,
  website    STRING,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP(),
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP()
);

-- 8. CRM Seller-Buyer links
CREATE TABLE IF NOT EXISTS `photons-377606.MPA.MPA_CRM_Contacts` (
  id         STRING NOT NULL,
  seller_id  STRING NOT NULL,
  buyer_id   STRING NOT NULL,
  linked_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP()
);

-- 9. CRM Personas
CREATE TABLE IF NOT EXISTS `photons-377606.MPA.MPA_CRM_Personas` (
  id             STRING  NOT NULL,
  seller_id      STRING  NOT NULL,
  name           STRING  NOT NULL,
  description    STRING,
  tone           STRING,
  seller_website STRING,
  buyer_website  STRING,
  auto_generated BOOL    DEFAULT FALSE,
  created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP()
);

-- 10. CRM Email Drafts
CREATE TABLE IF NOT EXISTS `photons-377606.MPA.MPA_CRM_Drafts` (
  id         STRING NOT NULL,
  seller_id  STRING NOT NULL,
  buyer_id   STRING NOT NULL,
  persona_id STRING,
  subject    STRING,
  body       STRING,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP()
);
