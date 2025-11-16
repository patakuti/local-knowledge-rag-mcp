import pkg from 'pg';
const { Client } = pkg;

const client = new Client({
  connectionString: process.env.DATABASE_URL,
});

async function initSchema() {
  try {
    await client.connect();
    console.log('Connected to PostgreSQL');

    // Enable pgvector extension
    await client.query('CREATE EXTENSION IF NOT EXISTS vector;');
    console.log('✓ pgvector extension enabled');

    // Drop existing table if it exists (for fresh setup)
    await client.query('DROP TABLE IF EXISTS embeddings CASCADE;');
    console.log('✓ dropped old embeddings table');

    // Create embeddings table
    // Note: vector dimension should match your embedding model
    // - 768 for Ollama nomic-embed-text or cl-nagoya/ruri models
    // - 1536 for OpenAI text-embedding-3-small
    // - 3072 for OpenAI text-embedding-3-large
    await client.query(`
      CREATE TABLE IF NOT EXISTS embeddings (
        id SERIAL PRIMARY KEY,
        path TEXT NOT NULL,
        mtime BIGINT NOT NULL,
        content TEXT NOT NULL,
        model TEXT NOT NULL,
        dimension SMALLINT NOT NULL,
        embedding vector(768) NOT NULL,
        metadata JSONB NOT NULL
      );
    `);
    console.log('✓ embeddings table created');

    // Create indexes
    await client.query(`
      CREATE INDEX IF NOT EXISTS embeddings_path_index ON embeddings (path);
      CREATE INDEX IF NOT EXISTS embeddings_model_index ON embeddings (model);
      CREATE INDEX IF NOT EXISTS embeddings_dimension_index ON embeddings (dimension);
    `);
    console.log('✓ basic indexes created');

    // Create HNSW index for cosine similarity search
    try {
      await client.query(`
        CREATE INDEX IF NOT EXISTS embeddings_embedding_idx
        ON embeddings
        USING hnsw (embedding vector_cosine_ops)
        WITH (m = 16, ef_construction = 64);
      `);
      console.log('✓ HNSW vector index created');
    } catch (indexError) {
      console.log('⚠ HNSW index creation failed:', indexError.message);
      console.log('⚠ Attempting IVFFlat index instead...');
      try {
        await client.query(`
          CREATE INDEX IF NOT EXISTS embeddings_embedding_idx
          ON embeddings
          USING ivfflat (embedding vector_cosine_ops)
          WITH (lists = 100);
        `);
        console.log('✓ IVFFlat vector index created as fallback');
      } catch (ivfError) {
        console.log('⚠ Vector index creation skipped (will create after data insertion)');
      }
    }

    // Verify table
    const result = await client.query(`
      SELECT column_name, data_type FROM information_schema.columns
      WHERE table_name = 'embeddings'
      ORDER BY ordinal_position;
    `);
    console.log('\n✓ Table structure:');
    result.rows.forEach(row => {
      console.log(`  ${row.column_name}: ${row.data_type}`);
    });

    console.log('\n✓ PostgreSQL schema initialization completed successfully!');
  } catch (error) {
    console.error('Error initializing schema:', error.message);
    process.exit(1);
  } finally {
    await client.end();
  }
}

initSchema();
