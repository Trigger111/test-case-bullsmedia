-- ============================================================
-- Bulls Media - Test task for analyst V3
-- Part 2: MySQL schema
--
-- Target: MySQL 8.0, InnoDB, utf8mb4_0900_ai_ci
--
-- The complete model: 5 tables + 5 views.
--
-- The script is IDEMPOTENT - re-running it is safe, on an empty
-- database or on a loaded one. Same rule as the Python loaders.
--
-- Objects are created in dependency order, because InnoDB
-- validates a foreign key the moment it is declared:
--
--     dim_currency  ->  dim_country  ->  exchange_rates
--                                    ->  gdp / population
--                                    ->  views
--
-- One asymmetry is deliberate. exchange_rates is upgraded in
-- place with guarded ALTERs, because its 408,928 rows cost
-- APILayer quota to fetch and must survive. gdp and population
-- are dropped and rebuilt, because the World Bank API is free
-- and unmetered - reloading them takes about two seconds, so
-- paying for a two-phase column migration would buy nothing.
--
-- Run in MySQL Workbench, or through Python: the guarded ALTERs
-- use PREPARE rather than DELIMITER, so both clients work.
-- ============================================================

CREATE DATABASE IF NOT EXISTS analyst_test
    CHARACTER SET utf8mb4
    COLLATE utf8mb4_0900_ai_ci;

USE analyst_test;


-- ============================================================
-- 1. dim_currency
--
-- Static ISO 4217 reference data, seeded from SQL because it
-- has no API source and does not change with a data refresh.
--
-- Why this table exists: exchange_rates carries 172 distinct
-- target_currency values, and they are not all spendable money.
-- Without these flags a currency slicer offers the user
-- "GDP in Bitcoin" and "GDP in Lithuanian litas".
--
--   is_fiat      0 for BTC, XAU, XAG, XDR, CLF
--   is_active    0 for currencies withdrawn from circulation
--   is_iso_4217  0 for BTC, CNH and the GBP-pegged Crown
--                dependency issues (GGP, IMP, JEP)
--   minor_units  decimal places; NULL where not applicable
--   replaced_by  self-referencing FK - the successor currency
-- ============================================================

CREATE TABLE IF NOT EXISTS dim_currency (
    currency_code   CHAR(3)           NOT NULL,
    currency_name   VARCHAR(60)       NOT NULL,
    is_fiat         BOOLEAN           NOT NULL DEFAULT TRUE,
    is_active       BOOLEAN           NOT NULL DEFAULT TRUE,
    is_iso_4217     BOOLEAN           NOT NULL DEFAULT TRUE,
    minor_units     TINYINT UNSIGNED  NULL,
    replaced_by     CHAR(3)           NULL,

    -- One field for the report to filter the currency slicer on, instead of
    -- making every visual repeat "is_fiat AND is_active". Generated, so it
    -- can never drift out of step with the two flags it derives from.
    is_selectable   BOOLEAN AS (is_fiat AND is_active) STORED,

    created_at      TIMESTAMP         NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMP         NOT NULL DEFAULT CURRENT_TIMESTAMP
                                               ON UPDATE CURRENT_TIMESTAMP,

    PRIMARY KEY (currency_code),

    -- A retired currency points at its successor, unless the
    -- successor is not quoted by our FX provider (e.g. ZWL -> ZWG).
    --
    -- No ON UPDATE CASCADE here: MySQL rejects a CHECK constraint
    -- on any column that also carries a referential action, and
    -- chk_currency_successor below is worth more than a cascade on
    -- codes that are immutable by definition.
    CONSTRAINT fk_currency_replaced_by
        FOREIGN KEY (replaced_by) REFERENCES dim_currency (currency_code),

    -- Reject anything that is not a three-letter uppercase code.
    CONSTRAINT chk_currency_code   CHECK (REGEXP_LIKE(currency_code, '^[A-Z]{3}$', 'c')),
    CONSTRAINT chk_currency_minor  CHECK (minor_units IS NULL OR minor_units <= 8),

    -- A currency cannot be its own successor.
    CONSTRAINT chk_currency_successor CHECK (replaced_by <> currency_code)
) ENGINE = InnoDB;


-- Seed: the 172 codes that APILayer actually returns for base USD.
-- replaced_by is set in a second pass below, because the
-- self-referencing FK is validated row by row on INSERT.
--
-- Upsert rather than plain INSERT, so re-running the script
-- refreshes the metadata instead of failing on duplicate keys.
INSERT INTO dim_currency
    (currency_code, currency_name, is_fiat, is_active, is_iso_4217, minor_units)
VALUES
    ('AED','UAE Dirham',                        1,1,1,2),
    ('AFN','Afghan Afghani',                    1,1,1,2),
    ('ALL','Albanian Lek',                      1,1,1,2),
    ('AMD','Armenian Dram',                     1,1,1,2),
    ('ANG','Netherlands Antillean Guilder',     1,0,1,2),
    ('AOA','Angolan Kwanza',                    1,1,1,2),
    ('ARS','Argentine Peso',                    1,1,1,2),
    ('AUD','Australian Dollar',                 1,1,1,2),
    ('AWG','Aruban Florin',                     1,1,1,2),
    ('AZN','Azerbaijani Manat',                 1,1,1,2),
    ('BAM','Bosnia-Herzegovina Convertible Mark',1,1,1,2),
    ('BBD','Barbadian Dollar',                  1,1,1,2),
    ('BDT','Bangladeshi Taka',                  1,1,1,2),
    ('BGN','Bulgarian Lev',                     1,1,1,2),
    ('BHD','Bahraini Dinar',                    1,1,1,3),
    ('BIF','Burundian Franc',                   1,1,1,0),
    ('BMD','Bermudan Dollar',                   1,1,1,2),
    ('BND','Brunei Dollar',                     1,1,1,2),
    ('BOB','Bolivian Boliviano',                1,1,1,2),
    ('BRL','Brazilian Real',                    1,1,1,2),
    ('BSD','Bahamian Dollar',                   1,1,1,2),
    ('BTC','Bitcoin',                           0,1,0,8),
    ('BTN','Bhutanese Ngultrum',                1,1,1,2),
    ('BWP','Botswanan Pula',                    1,1,1,2),
    ('BYN','Belarusian Ruble',                  1,1,1,2),
    ('BYR','Belarusian Ruble (2000-2016)',      1,0,0,0),
    ('BZD','Belize Dollar',                     1,1,1,2),
    ('CAD','Canadian Dollar',                   1,1,1,2),
    ('CDF','Congolese Franc',                   1,1,1,2),
    ('CHF','Swiss Franc',                       1,1,1,2),
    ('CLF','Chilean Unidad de Fomento',         0,1,1,4),
    ('CLP','Chilean Peso',                      1,1,1,0),
    ('CNH','Chinese Yuan (Offshore)',           1,1,0,2),
    ('CNY','Chinese Yuan',                      1,1,1,2),
    ('COP','Colombian Peso',                    1,1,1,2),
    ('CRC','Costa Rican Colon',                 1,1,1,2),
    ('CUC','Cuban Convertible Peso',            1,0,1,2),
    ('CUP','Cuban Peso',                        1,1,1,2),
    ('CVE','Cape Verdean Escudo',               1,1,1,2),
    ('CZK','Czech Koruna',                      1,1,1,2),
    ('DJF','Djiboutian Franc',                  1,1,1,0),
    ('DKK','Danish Krone',                      1,1,1,2),
    ('DOP','Dominican Peso',                    1,1,1,2),
    ('DZD','Algerian Dinar',                    1,1,1,2),
    ('EGP','Egyptian Pound',                    1,1,1,2),
    ('ERN','Eritrean Nakfa',                    1,1,1,2),
    ('ETB','Ethiopian Birr',                    1,1,1,2),
    ('EUR','Euro',                              1,1,1,2),
    ('FJD','Fijian Dollar',                     1,1,1,2),
    ('FKP','Falkland Islands Pound',            1,1,1,2),
    ('GBP','British Pound Sterling',            1,1,1,2),
    ('GEL','Georgian Lari',                     1,1,1,2),
    ('GGP','Guernsey Pound',                    1,1,0,2),
    ('GHS','Ghanaian Cedi',                     1,1,1,2),
    ('GIP','Gibraltar Pound',                   1,1,1,2),
    ('GMD','Gambian Dalasi',                    1,1,1,2),
    ('GNF','Guinean Franc',                     1,1,1,0),
    ('GTQ','Guatemalan Quetzal',                1,1,1,2),
    ('GYD','Guyanaese Dollar',                  1,1,1,2),
    ('HKD','Hong Kong Dollar',                  1,1,1,2),
    ('HNL','Honduran Lempira',                  1,1,1,2),
    ('HRK','Croatian Kuna',                     1,0,1,2),
    ('HTG','Haitian Gourde',                    1,1,1,2),
    ('HUF','Hungarian Forint',                  1,1,1,2),
    ('IDR','Indonesian Rupiah',                 1,1,1,2),
    ('ILS','Israeli New Shekel',                1,1,1,2),
    ('IMP','Isle of Man Pound',                 1,1,0,2),
    ('INR','Indian Rupee',                      1,1,1,2),
    ('IQD','Iraqi Dinar',                       1,1,1,3),
    ('IRR','Iranian Rial',                      1,1,1,2),
    ('ISK','Icelandic Krona',                   1,1,1,0),
    ('JEP','Jersey Pound',                      1,1,0,2),
    ('JMD','Jamaican Dollar',                   1,1,1,2),
    ('JOD','Jordanian Dinar',                   1,1,1,3),
    ('JPY','Japanese Yen',                      1,1,1,0),
    ('KES','Kenyan Shilling',                   1,1,1,2),
    ('KGS','Kyrgystani Som',                    1,1,1,2),
    ('KHR','Cambodian Riel',                    1,1,1,2),
    ('KMF','Comorian Franc',                    1,1,1,0),
    ('KPW','North Korean Won',                  1,1,1,2),
    ('KRW','South Korean Won',                  1,1,1,0),
    ('KWD','Kuwaiti Dinar',                     1,1,1,3),
    ('KYD','Cayman Islands Dollar',             1,1,1,2),
    ('KZT','Kazakhstani Tenge',                 1,1,1,2),
    ('LAK','Laotian Kip',                       1,1,1,2),
    ('LBP','Lebanese Pound',                    1,1,1,2),
    ('LKR','Sri Lankan Rupee',                  1,1,1,2),
    ('LRD','Liberian Dollar',                   1,1,1,2),
    ('LSL','Lesotho Loti',                      1,1,1,2),
    ('LTL','Lithuanian Litas',                  1,0,0,2),
    ('LVL','Latvian Lats',                      1,0,0,2),
    ('LYD','Libyan Dinar',                      1,1,1,3),
    ('MAD','Moroccan Dirham',                   1,1,1,2),
    ('MDL','Moldovan Leu',                      1,1,1,2),
    ('MGA','Malagasy Ariary',                   1,1,1,2),
    ('MKD','Macedonian Denar',                  1,1,1,2),
    ('MMK','Myanmar Kyat',                      1,1,1,2),
    ('MNT','Mongolian Tugrik',                  1,1,1,2),
    ('MOP','Macanese Pataca',                   1,1,1,2),
    ('MRU','Mauritanian Ouguiya',               1,1,1,2),
    ('MUR','Mauritian Rupee',                   1,1,1,2),
    ('MVR','Maldivian Rufiyaa',                 1,1,1,2),
    ('MWK','Malawian Kwacha',                   1,1,1,2),
    ('MXN','Mexican Peso',                      1,1,1,2),
    ('MYR','Malaysian Ringgit',                 1,1,1,2),
    ('MZN','Mozambican Metical',                1,1,1,2),
    ('NAD','Namibian Dollar',                   1,1,1,2),
    ('NGN','Nigerian Naira',                    1,1,1,2),
    ('NIO','Nicaraguan Cordoba',                1,1,1,2),
    ('NOK','Norwegian Krone',                   1,1,1,2),
    ('NPR','Nepalese Rupee',                    1,1,1,2),
    ('NZD','New Zealand Dollar',                1,1,1,2),
    ('OMR','Omani Rial',                        1,1,1,3),
    ('PAB','Panamanian Balboa',                 1,1,1,2),
    ('PEN','Peruvian Sol',                      1,1,1,2),
    ('PGK','Papua New Guinean Kina',            1,1,1,2),
    ('PHP','Philippine Peso',                   1,1,1,2),
    ('PKR','Pakistani Rupee',                   1,1,1,2),
    ('PLN','Polish Zloty',                      1,1,1,2),
    ('PYG','Paraguayan Guarani',                1,1,1,0),
    ('QAR','Qatari Rial',                       1,1,1,2),
    ('RON','Romanian Leu',                      1,1,1,2),
    ('RSD','Serbian Dinar',                     1,1,1,2),
    ('RUB','Russian Ruble',                     1,1,1,2),
    ('RWF','Rwandan Franc',                     1,1,1,0),
    ('SAR','Saudi Riyal',                       1,1,1,2),
    ('SBD','Solomon Islands Dollar',            1,1,1,2),
    ('SCR','Seychellois Rupee',                 1,1,1,2),
    ('SDG','Sudanese Pound',                    1,1,1,2),
    ('SEK','Swedish Krona',                     1,1,1,2),
    ('SGD','Singapore Dollar',                  1,1,1,2),
    ('SHP','Saint Helena Pound',                1,1,1,2),
    ('SLE','Sierra Leonean Leone',              1,1,1,2),
    ('SLL','Sierra Leonean Leone (1964-2022)',  1,0,1,2),
    ('SOS','Somali Shilling',                   1,1,1,2),
    ('SRD','Surinamese Dollar',                 1,1,1,2),
    ('STD','Sao Tome Dobra (1977-2017)',        1,0,1,2),
    ('STN','Sao Tome and Principe Dobra',       1,1,1,2),
    ('SVC','Salvadoran Colon',                  1,0,1,2),
    ('SYP','Syrian Pound',                      1,1,1,2),
    ('SZL','Swazi Lilangeni',                   1,1,1,2),
    ('THB','Thai Baht',                         1,1,1,2),
    ('TJS','Tajikistani Somoni',                1,1,1,2),
    ('TMT','Turkmenistani Manat',               1,1,1,2),
    ('TND','Tunisian Dinar',                    1,1,1,3),
    ('TOP','Tongan Paanga',                     1,1,1,2),
    ('TRY','Turkish Lira',                      1,1,1,2),
    ('TTD','Trinidad and Tobago Dollar',        1,1,1,2),
    ('TWD','New Taiwan Dollar',                 1,1,1,2),
    ('TZS','Tanzanian Shilling',                1,1,1,2),
    ('UAH','Ukrainian Hryvnia',                 1,1,1,2),
    ('UGX','Ugandan Shilling',                  1,1,1,0),
    ('USD','United States Dollar',              1,1,1,2),
    ('UYU','Uruguayan Peso',                    1,1,1,2),
    ('UZS','Uzbekistani Som',                   1,1,1,2),
    ('VES','Venezuelan Bolivar Soberano',       1,1,1,2),
    ('VND','Vietnamese Dong',                   1,1,1,0),
    ('VUV','Vanuatu Vatu',                      1,1,1,0),
    ('WST','Samoan Tala',                       1,1,1,2),
    ('XAF','Central African CFA Franc',         1,1,1,0),
    ('XAG','Silver (troy ounce)',               0,1,1,NULL),
    ('XAU','Gold (troy ounce)',                 0,1,1,NULL),
    ('XCD','East Caribbean Dollar',             1,1,1,2),
    ('XCG','Caribbean Guilder',                 1,1,1,2),
    ('XDR','IMF Special Drawing Rights',        0,1,1,NULL),
    ('XOF','West African CFA Franc',            1,1,1,0),
    ('XPF','CFP Franc',                         1,1,1,0),
    ('YER','Yemeni Rial',                       1,1,1,2),
    ('ZAR','South African Rand',                1,1,1,2),
    ('ZMK','Zambian Kwacha (1968-2013)',        1,0,1,2),
    ('ZMW','Zambian Kwacha',                    1,1,1,2),
    ('ZWL','Zimbabwean Dollar',                 1,0,1,2)
AS new
ON DUPLICATE KEY UPDATE
    currency_name = new.currency_name,
    is_fiat       = new.is_fiat,
    is_active     = new.is_active,
    is_iso_4217   = new.is_iso_4217,
    minor_units   = new.minor_units;


-- Second pass: link retired currencies to their successors.
-- ZWL is deliberately left NULL - its successor ZWG is not
-- quoted by the provider, so pointing at it would break the FK.
UPDATE dim_currency SET replaced_by = 'BYN' WHERE currency_code = 'BYR';
UPDATE dim_currency SET replaced_by = 'CUP' WHERE currency_code = 'CUC';
UPDATE dim_currency SET replaced_by = 'EUR' WHERE currency_code IN ('HRK','LTL','LVL');
UPDATE dim_currency SET replaced_by = 'SLE' WHERE currency_code = 'SLL';
UPDATE dim_currency SET replaced_by = 'STN' WHERE currency_code = 'STD';
UPDATE dim_currency SET replaced_by = 'USD' WHERE currency_code = 'SVC';
UPDATE dim_currency SET replaced_by = 'XCG' WHERE currency_code = 'ANG';
UPDATE dim_currency SET replaced_by = 'ZMW' WHERE currency_code = 'ZMK';


-- Guarded upgrade for a dim_currency that already exists.
SET @ddl = IF(
    (SELECT COUNT(*) FROM information_schema.columns
      WHERE table_schema = DATABASE()
        AND table_name   = 'dim_currency'
        AND column_name  = 'is_selectable') = 0,
    'ALTER TABLE dim_currency
        ADD COLUMN is_selectable BOOLEAN AS (is_fiat AND is_active) STORED
        AFTER replaced_by',
    'DO 0');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;


-- ============================================================
-- 2. dim_country
--
-- Populated by dimensions.ipynb from the World Bank country
-- endpoint. Kept empty here so the foreign keys below validate.
--
-- country_iso3 is the join key, not country_name: the World Bank
-- labels are things like "Korea, Dem. People's Rep." - a 100-char
-- string is a poor key and Power BI map visuals do not reliably
-- geocode those labels.
--
-- local_currency is nullable on purpose. South Sudan's SSP is not
-- quoted by the FX provider, so the honest value is NULL rather
-- than a wrong guess. The loader reports every unmapped country.
-- ============================================================

CREATE TABLE IF NOT EXISTS dim_country (
    country_iso3    CHAR(3)      NOT NULL,
    country_name    VARCHAR(100) NOT NULL,
    region          VARCHAR(60)  NULL,
    income_group    VARCHAR(60)  NULL,
    local_currency  CHAR(3)      NULL,
    created_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
                                          ON UPDATE CURRENT_TIMESTAMP,

    PRIMARY KEY (country_iso3),
    UNIQUE KEY uq_country_name (country_name),

    CONSTRAINT fk_country_currency
        FOREIGN KEY (local_currency) REFERENCES dim_currency (currency_code)
        ON UPDATE CASCADE,

    CONSTRAINT chk_country_iso3 CHECK (REGEXP_LIKE(country_iso3, '^[A-Z]{3}$', 'c'))
) ENGINE = InnoDB;


-- ============================================================
-- 3. exchange_rates
--
-- Spec columns: (date, base_currency, target_currency, rate).
--
-- DECIMAL(20,10) rather than DOUBLE: FX rates are financial
-- figures, and binary floating point cannot represent them
-- exactly. 10 integer digits cover IRR at ~1.3 million per USD.
--
-- The composite PK is the natural key. It is what makes the
-- Python loader idempotent via ON DUPLICATE KEY UPDATE.
--
-- rate_year is a STORED generated column. Without it, the annual
-- aggregation has to compute YEAR(date) at query time, which no
-- index can serve - EXPLAIN showed a full scan of 405,868 rows
-- plus a temporary table. With it, ix_fx_currency_year covers
-- the whole aggregation.
-- ============================================================

CREATE TABLE IF NOT EXISTS exchange_rates (
    `date`           DATE              NOT NULL,
    base_currency    CHAR(3)           NOT NULL,
    target_currency  CHAR(3)           NOT NULL,
    rate             DECIMAL(20,10)    NOT NULL,
    rate_year        SMALLINT UNSIGNED AS (YEAR(`date`)) STORED,
    created_at       TIMESTAMP         NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at       TIMESTAMP         NOT NULL DEFAULT CURRENT_TIMESTAMP
                                                ON UPDATE CURRENT_TIMESTAMP,

    PRIMARY KEY (`date`, base_currency, target_currency),

    -- Covering index: (target_currency, rate_year, rate) answers
    -- "average rate per currency per year" from the index alone.
    -- EXPLAIN goes from  type=ALL, rows=405868, Using temporary
    -- to                 type=ref, rows=2427,   Using index
    -- and a single-currency lookup drops from 90 ms to 3 ms.
    --
    -- InnoDB will also auto-create an index on base_currency to
    -- support fk_fx_base. It is redundant here (the column is
    -- always 'USD'), but a foreign key requires an index on the
    -- child column, so it is the price of the constraint.
    KEY ix_fx_currency_year (target_currency, rate_year, rate),

    CONSTRAINT fk_fx_base
        FOREIGN KEY (base_currency)   REFERENCES dim_currency (currency_code)
        ON UPDATE CASCADE,
    CONSTRAINT fk_fx_target
        FOREIGN KEY (target_currency) REFERENCES dim_currency (currency_code)
        ON UPDATE CASCADE,

    CONSTRAINT chk_fx_rate CHECK (rate > 0)
) ENGINE = InnoDB;


-- ------------------------------------------------------------
-- 3b. Guarded upgrade for an exchange_rates that already holds
--     data from an earlier run.
--
--     Each block checks information_schema first and compiles to
--     "DO 0" when the object is already there, which is what
--     makes the script re-runnable. PREPARE is used instead of a
--     stored procedure so the file needs no DELIMITER and runs
--     unchanged from Workbench or from Python.
--
--     Adding a STORED generated column rebuilds the table, so on
--     408,928 rows expect a few seconds.
-- ------------------------------------------------------------

-- rate_year: the generated column that makes annual aggregation
-- indexable.
SET @ddl = IF(
    (SELECT COUNT(*) FROM information_schema.columns
      WHERE table_schema = DATABASE()
        AND table_name   = 'exchange_rates'
        AND column_name  = 'rate_year') = 0,
    'ALTER TABLE exchange_rates
        ADD COLUMN rate_year SMALLINT UNSIGNED AS (YEAR(`date`)) STORED AFTER rate',
    'DO 0');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Audit columns: the evidence that the incremental load in
-- api.ipynb actually updates rows rather than only inserting them.
SET @ddl = IF(
    (SELECT COUNT(*) FROM information_schema.columns
      WHERE table_schema = DATABASE()
        AND table_name   = 'exchange_rates'
        AND column_name  = 'created_at') = 0,
    'ALTER TABLE exchange_rates
        ADD COLUMN created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        ADD COLUMN updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
                                                 ON UPDATE CURRENT_TIMESTAMP',
    'DO 0');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Covering index for fact_fx_annual.
SET @ddl = IF(
    (SELECT COUNT(*) FROM information_schema.statistics
      WHERE table_schema = DATABASE()
        AND table_name   = 'exchange_rates'
        AND index_name   = 'ix_fx_currency_year') = 0,
    'ALTER TABLE exchange_rates
        ADD KEY ix_fx_currency_year (target_currency, rate_year, rate)',
    'DO 0');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Foreign keys to dim_currency. Safe to add now: dim_currency was
-- seeded above with all 172 codes the table actually contains.
SET @ddl = IF(
    (SELECT COUNT(*) FROM information_schema.table_constraints
      WHERE table_schema    = DATABASE()
        AND table_name      = 'exchange_rates'
        AND constraint_name = 'fk_fx_target') = 0,
    'ALTER TABLE exchange_rates
        ADD CONSTRAINT fk_fx_base
            FOREIGN KEY (base_currency)   REFERENCES dim_currency (currency_code)
            ON UPDATE CASCADE,
        ADD CONSTRAINT fk_fx_target
            FOREIGN KEY (target_currency) REFERENCES dim_currency (currency_code)
            ON UPDATE CASCADE',
    'DO 0');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;


-- ============================================================
-- 4. gdp and population
--
-- Spec columns: gdp(id, year, country, gdp_in_usd) and
-- population(id, year, country, population).
--
-- country is kept as the spec requires it, and it records what
-- the API actually returned. country_iso3 is added as the real
-- join key and carries the FK, so the natural unique key is
-- (year, country_iso3) rather than (year, country).
--
-- YEAR is a 1-byte type with a 1901-2155 range - the narrowest
-- correct type here. Its tradeoff is portability: it is a
-- MySQL-specific type, so on another engine this would be
-- SMALLINT UNSIGNED with a CHECK.
--
-- DECIMAL(20,2) for GDP: 18 integer digits against a world total
-- near 1e14, with cents preserved rather than rounded away.
--
-- Dropped and rebuilt rather than migrated in place: adding a
-- NOT NULL key column to a populated table needs two passes with
-- a loader run in between, and the World Bank API refills both
-- tables in seconds at no quota cost.
-- ============================================================

DROP TABLE IF EXISTS gdp;
DROP TABLE IF EXISTS population;

CREATE TABLE gdp (
    id            INT UNSIGNED  NOT NULL AUTO_INCREMENT,
    `year`        YEAR          NOT NULL,
    country       VARCHAR(100)  NOT NULL,
    country_iso3  CHAR(3)       NOT NULL,
    gdp_in_usd    DECIMAL(20,2) NOT NULL,
    created_at    TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at    TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP
                                         ON UPDATE CURRENT_TIMESTAMP,

    PRIMARY KEY (id),
    UNIQUE KEY uq_gdp_year_country (`year`, country_iso3),

    CONSTRAINT fk_gdp_country
        FOREIGN KEY (country_iso3) REFERENCES dim_country (country_iso3)
        ON UPDATE CASCADE,

    CONSTRAINT chk_gdp_positive CHECK (gdp_in_usd > 0)
) ENGINE = InnoDB;


CREATE TABLE population (
    id            INT UNSIGNED    NOT NULL AUTO_INCREMENT,
    `year`        YEAR            NOT NULL,
    country       VARCHAR(100)    NOT NULL,
    country_iso3  CHAR(3)         NOT NULL,
    population    BIGINT UNSIGNED NOT NULL,
    created_at    TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at    TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP
                                           ON UPDATE CURRENT_TIMESTAMP,

    PRIMARY KEY (id),
    UNIQUE KEY uq_population_year_country (`year`, country_iso3),

    CONSTRAINT fk_population_country
        FOREIGN KEY (country_iso3) REFERENCES dim_country (country_iso3)
        ON UPDATE CASCADE,

    CONSTRAINT chk_population_positive CHECK (population > 0)
) ENGINE = InnoDB;


-- ============================================================
-- 5. fact_fx_annual
--
-- The one FX object Power BI imports: 1,185 rows instead of
-- 408,928. GDP and population are annual, so a single rate per
-- (year, currency) carries all the information a currency
-- conversion needs - a 345x row reduction.
--
-- Pre-aggregating here rather than in DAX also removes a whole
-- class of measure bug: AVERAGE() over daily rates silently
-- averages across years whenever no year is selected.
--
-- Two rates, because the correct one depends on the variable:
--
--   avg_rate  period average  -> FLOWS  (GDP, trade, income)
--   eoy_rate  end of period   -> STOCKS (debt, reserves, market cap)
--
-- GDP is a flow, so the dashboard converts with avg_rate. This
-- also matches how the World Bank builds "GDP (current US$)".
--
-- Caveat worth knowing: the provider carries the Friday rate
-- through Saturday and Sunday, so weekend days are not
-- independent observations and Friday is effectively weighted
-- triple. The distortion measures under 0.1%, but avg_rate is a
-- calendar-day average, not a trading-day average.
--
-- coverage_pct is obs_count over the number of days in that
-- calendar year. The provider quotes every day including weekends,
-- so a fully covered currency-year has 365 or 366 observations.
--
-- Counting observations rather than testing the last date matters:
-- a currency the provider *started* quoting mid-year has a complete
-- tail and would otherwise look fine. STN and XCG begin 2025-07-18,
-- MRU/SLE/VES begin late 2022 - each has a first year whose average
-- covers only part of it, and is not comparable with a full year.
--
-- is_partial_year then trips below 95% rather than on any gap at
-- all, because the two cases are different in kind:
--
--   provider missed a day or two   ->  363/365, 99.5% - usable
--   currency did not exist yet     ->   26/365,  7.1% - not usable
--
-- A strict "any missing day" test flags 202 currency-years, nearly
-- all of them harmless. The 95% threshold flags the ~35 where the
-- average really is built on a partial year.
--
-- This is the flag the DAX currency guard reads before showing a
-- converted figure.
-- ============================================================

-- ============================================================
-- 4b. dim_year
--
-- The shared year dimension. Every fact in this model is annual,
-- so `year` is the axis all three of them hang off, and Power BI
-- needs one table to filter them together.
--
-- Built from the union of the facts rather than a hard-coded range,
-- so it extends itself when a new year of data lands.
--
-- The count columns exist to answer the question the dashboard will
-- otherwise get asked: "why is this year empty?" 2026 has FX rates
-- for 172 currencies and no GDP at all, and that is visible here
-- instead of showing up as a blank chart.
-- ============================================================

CREATE OR REPLACE VIEW dim_year AS
SELECT
    y.`year`,
    CASE WHEN y.`year` = YEAR(CURRENT_DATE) THEN 1 ELSE 0 END AS is_current_year,
    (SELECT COUNT(*) FROM gdp AS g
      WHERE g.`year` = y.`year`)                    AS gdp_countries,
    (SELECT COUNT(*) FROM population AS p
      WHERE p.`year` = y.`year`)                    AS population_countries,
    (SELECT COUNT(DISTINCT r.target_currency) FROM exchange_rates AS r
      WHERE r.rate_year = y.`year`)                 AS fx_currencies
FROM (
    SELECT DISTINCT CAST(`year` AS UNSIGNED) AS `year` FROM gdp
    UNION
    SELECT DISTINCT CAST(`year` AS UNSIGNED)           FROM population
    UNION
    SELECT DISTINCT rate_year                          FROM exchange_rates
) AS y;


-- Superseded by fact_fx_annual, which adds eoy_rate, the coverage
-- columns and the partial-year flag.
DROP VIEW IF EXISTS annual_exchange_rates;

CREATE OR REPLACE VIEW fact_fx_annual AS
SELECT
    agg.rate_year                        AS `year`,
    agg.base_currency,
    agg.target_currency,
    agg.avg_rate,
    eoy.rate                             AS eoy_rate,
    agg.min_rate,
    agg.max_rate,
    agg.obs_count,
    agg.days_in_year,
    ROUND(agg.obs_count / agg.days_in_year, 4) AS coverage_pct,
    agg.first_date,
    agg.last_date,
    CASE
        WHEN agg.obs_count / agg.days_in_year < 0.95 THEN 1
        ELSE 0
    END                                  AS is_partial_year
FROM (
    SELECT
        rate_year,
        base_currency,
        target_currency,
        AVG(rate)     AS avg_rate,
        MIN(rate)     AS min_rate,
        MAX(rate)     AS max_rate,
        COUNT(*)      AS obs_count,
        MIN(`date`)   AS first_date,
        MAX(`date`)   AS last_date,
        -- 365, or 366 in a leap year.
        DATEDIFF(
            MAKEDATE(rate_year + 1, 1),
            MAKEDATE(rate_year, 1)
        )             AS days_in_year
    FROM exchange_rates
    GROUP BY rate_year, base_currency, target_currency
) AS agg
-- Join back on the last observed date to pick up the closing rate.
-- The join hits the primary key, so this costs one seek per group.
LEFT JOIN exchange_rates AS eoy
       ON eoy.`date`           = agg.last_date
      AND eoy.base_currency    = agg.base_currency
      AND eoy.target_currency  = agg.target_currency;


-- ============================================================
-- 6. fx_rate_outliers
--
-- Data-quality view, and the evidence behind the "Data Quality"
-- page of the report.
--
-- Method: compare each daily rate against a centred 31-day
-- moving average of the same currency. A real currency does not
-- move by more than 2x or less than 0.5x against its own
-- one-month neighbourhood; a provider glitch does.
--
-- Current result: 194 rows out of 408,928 (0.047%) across 15
-- currencies. Two are unmistakable single-day glitches -
-- HNL 2023-01-18 = 0.0339 against a true rate near 24.6, and
-- MGA 2022-12-06 = 3.47 against a true rate near 4,400. Others
-- (GHS, LYD, YER) are multi-week windows where the provider
-- appears to switch between official and parallel-market rates.
--
-- Deliberately NOT filtered out of exchange_rates: the raw API
-- response stays as delivered, and the view makes the problem
-- visible and countable instead of hiding it.
-- ============================================================

CREATE OR REPLACE VIEW fx_rate_outliers AS
WITH smoothed AS (
    SELECT
        `date`,
        rate_year,
        base_currency,
        target_currency,
        rate,
        AVG(rate) OVER (
            PARTITION BY base_currency, target_currency
            ORDER BY `date`
            ROWS BETWEEN 15 PRECEDING AND 15 FOLLOWING
        ) AS local_avg
    FROM exchange_rates
)
SELECT
    `date`,
    rate_year AS `year`,
    base_currency,
    target_currency,
    rate,
    ROUND(local_avg, 6)         AS local_avg_31d,
    ROUND(rate / local_avg, 4)  AS ratio_to_local_avg
FROM smoothed
WHERE local_avg > 0
  AND (rate / local_avg < 0.5 OR rate / local_avg > 2.0);


-- ============================================================
-- 7. vw_gdp_per_capita
--
-- Validation view, not a reporting source. The dashboard computes
-- GDP per capita as a DAX measure so it responds to slicers; this
-- view exists so the measure can be cross-checked against SQL.
--
-- INNER JOIN on purpose: a country-year needs both figures to
-- have a per-capita value. The row count difference against the
-- gdp table is itself the coverage report.
-- ============================================================

CREATE OR REPLACE VIEW vw_gdp_per_capita AS
SELECT
    g.`year`,
    g.country_iso3,
    c.country_name,
    c.region,
    g.gdp_in_usd,
    p.population,
    ROUND(g.gdp_in_usd / p.population, 2) AS gdp_per_capita_usd
FROM gdp AS g
JOIN population AS p
      ON p.`year`        = g.`year`
     AND p.country_iso3  = g.country_iso3
JOIN dim_country AS c
      ON c.country_iso3  = g.country_iso3;


-- ============================================================
-- 8. vw_data_quality
--
-- The test suite for the dataset, expressed as SQL. Each row is
-- one check with its current value, so a refresh that breaks
-- something shows up as a changed number rather than a silently
-- wrong chart.
-- ============================================================

CREATE OR REPLACE VIEW vw_data_quality AS
-- One row per check. Three columns carry the meaning:
--
--   status  WARN = something to look at, INFO = a load counter or an expected state.
--           Without it a reader cannot tell 408,928 rows loaded (fine) from
--           194 suspect rates (not fine) - both are just numbers in a column.
--   unit    what metric counts. The units are NOT the same across rows: rows,
--           currencies, countries and country-years all appear, which is exactly
--           why metric must never be summed.
--   detail  the offending keys, so a finding can be acted on without a second query.
SELECT 'INFO' AS status, 'FX' AS area, 'rows loaded' AS check_name,
       COUNT(*) AS metric, 'rows (one rate per day)' AS unit, NULL AS detail
       FROM exchange_rates
UNION ALL
SELECT 'INFO', 'FX',       'distinct target currencies',
       COUNT(DISTINCT target_currency), 'currencies', NULL             FROM exchange_rates
UNION ALL
SELECT 'INFO', 'FX',       'currencies excluded from slicer (non-fiat or retired)',
       COUNT(*), 'currencies', GROUP_CONCAT(currency_code ORDER BY currency_code)
       FROM dim_currency WHERE is_fiat = 0 OR is_active = 0
UNION ALL
SELECT 'WARN', 'FX',       'suspected bad rates (31d outlier test)',
       COUNT(*), 'daily rates', NULL                                   FROM fx_rate_outliers
UNION ALL
-- Split in two: the year in progress is partial for every currency and is
-- expected, so lumping it in would bury the handful that actually matter.
SELECT 'INFO', 'FX',       'partial currency-years - year in progress (expected)',
       COUNT(*), 'currency-years', NULL
       FROM fact_fx_annual
       WHERE is_partial_year = 1 AND `year` = YEAR(CURRENT_DATE)
UNION ALL
SELECT 'WARN', 'FX',       'partial currency-years - currency not quoted all year',
       COUNT(*), 'currency-years',
       GROUP_CONCAT(CONCAT(target_currency, ' ', `year`) ORDER BY target_currency)
       FROM fact_fx_annual
       WHERE is_partial_year = 1 AND `year` < YEAR(CURRENT_DATE)
UNION ALL
SELECT 'INFO', 'GDP',      'rows loaded',
       COUNT(*), 'rows (country-year)', NULL                           FROM gdp
UNION ALL
SELECT 'WARN', 'GDP',      'countries with population but no GDP in any year',
       COUNT(*), 'countries', GROUP_CONCAT(country_iso3 ORDER BY country_iso3)
       FROM (SELECT DISTINCT p.country_iso3
             FROM population p
             LEFT JOIN gdp g ON g.country_iso3 = p.country_iso3
             WHERE g.id IS NULL) AS missing
UNION ALL
SELECT 'WARN', 'GDP',      'country-years with population but no GDP',
       COUNT(*), 'country-years', NULL
       FROM population p
       LEFT JOIN gdp g ON g.`year` = p.`year` AND g.country_iso3 = p.country_iso3
       WHERE g.id IS NULL
UNION ALL
SELECT 'INFO', 'POPULATION', 'rows loaded',
       COUNT(*), 'rows (country-year)', NULL                           FROM population
UNION ALL
SELECT 'WARN', 'DIM',      'countries without a mapped local currency',
       COUNT(*), 'countries', GROUP_CONCAT(country_iso3 ORDER BY country_iso3)
       FROM dim_country WHERE local_currency IS NULL;


-- ============================================================
-- 9. Verification
--
-- Run after the loaders. Expected as of 2026-08-23:
--   dim_currency  172
--   dim_country   217
--   exchange_rates 408,928   fact_fx_annual 1,185
--   gdp           1,219      population     1,302
-- ============================================================

-- SELECT * FROM vw_data_quality;
--
-- Proof that the generated column plus covering index removed the
-- full scan. Before: type=ALL, rows=405868, Using temporary.
-- SELECT * FROM fact_fx_annual WHERE target_currency = 'EUR';
