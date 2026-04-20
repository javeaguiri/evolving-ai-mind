## Documentation Index
> Fetch the complete documentation index at: https://docs.perplexity.ai/llms.txt
> Use this file to discover all available pages before exploring further.

# Standard Embeddings

> Generate embeddings for independent texts, search queries, and single sentences.

## Overview

Use standard embeddings for independent text embedding (queries, documents, and semantic search) where each text is self-contained.

## Models

|         Model        | Dimensions | Context | MRL | Quantization | Price (\$/1M tokens) |
| :------------------: | :--------: | :-----: | :-: | :----------: | :------------------: |
| `pplx-embed-v1-0.6b` |    1024    |   32K   | Yes |  INT8/BINARY |        \$0.004       |
|  `pplx-embed-v1-4b`  |    2560    |   32K   | Yes |  INT8/BINARY |        \$0.03        |

## Basic Usage

Generate embeddings for a list of texts:

<CodeGroup>
  ```python Python theme={null}
  from perplexity import Perplexity

  client = Perplexity()

  response = client.embeddings.create(
      input=[
          "Scientists explore the universe driven by curiosity.",
          "Curiosity compels us to seek explanations, not just observations.",
          "Historical discoveries began with curious questions.",
          "The pursuit of knowledge distinguishes human curiosity from mere stimulus response.",
          "Philosophy examines the nature of curiosity."
      ],
      model="pplx-embed-v1-4b"
  )

  for emb in response.data:
      print(f"Index {emb.index}: {emb.embedding}")
  ```

  ```typescript TypeScript theme={null}
  import Perplexity from '@perplexity-ai/perplexity_ai';

  const client = new Perplexity();

  const response = await client.embeddings.create({
      input: [
          "Scientists explore the universe driven by curiosity.",
          "Curiosity compels us to seek explanations, not just observations.",
          "Historical discoveries began with curious questions.",
          "The pursuit of knowledge distinguishes human curiosity from mere stimulus response.",
          "Philosophy examines the nature of curiosity."
      ],
      model: "pplx-embed-v1-4b"
  });

  for (const emb of response.data!) {
      console.log(`Index ${emb.index}: ${emb.embedding!}`);
  }
  ```

  ```bash cURL theme={null}
  curl -X POST 'https://api.perplexity.ai/v1/embeddings' \
    -H "Authorization: Bearer $PERPLEXITY_API_KEY" \
    -H 'Content-Type: application/json' \
    -d '{
      "input": [
        "Scientists explore the universe driven by curiosity.",
        "Curiosity compels us to seek explanations, not just observations.",
        "Historical discoveries began with curious questions.",
        "The pursuit of knowledge distinguishes human curiosity from mere stimulus response.",
        "Philosophy examines the nature of curiosity."
      ],
      "model": "pplx-embed-v1-4b"
    }' | jq
  ```
</CodeGroup>

<Accordion title="Response">
  ```json theme={null}
  {
    "object": "list",
    "data": [
      {
        "object": "embedding",
        "index": 0,
        "embedding": "/* base64-encoded signed int8 values */"
      },
      {
        "object": "embedding",
        "index": 1,
        "embedding": "/* base64-encoded signed int8 values */"
      },
      {
        "object": "embedding",
        "index": 2,
        "embedding": "/* base64-encoded signed int8 values */"
      },
      {
        "object": "embedding",
        "index": 3,
        "embedding": "/* base64-encoded signed int8 values */"
      },
      {
        "object": "embedding",
        "index": 4,
        "embedding": "/* base64-encoded signed int8 values */"
      }
    ],
    "model": "pplx-embed-v1-4b",
    "usage": {
      "prompt_tokens": 42,
      "total_tokens": 42,
      "cost": {
        "input_cost": 0.0000013,
        "total_cost": 0.0000013,
        "currency": "USD"
      }
    }
  }
  ```
</Accordion>

## Semantic Search Example

Build a simple semantic search system:

<CodeGroup>
  ```python Python theme={null}
  import base64
  import numpy as np
  from perplexity import Perplexity

  client = Perplexity()

  def decode_embedding(b64_string):
      """Decode a base64-encoded int8 embedding."""
      return np.frombuffer(base64.b64decode(b64_string), dtype=np.int8).astype(np.float32)

  def cosine_similarity(a, b):
      return np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b))

  # 1. Embed your documents
  documents = [
      "Python is a versatile programming language",
      "Machine learning automates analytical model building",
      "The Eiffel Tower is located in Paris, France"
  ]

  doc_response = client.embeddings.create(input=documents, model="pplx-embed-v1-4b")
  doc_embeddings = [decode_embedding(emb.embedding) for emb in doc_response.data]

  # 2. Embed a search query
  query = "What programming languages are good for data science?"
  query_response = client.embeddings.create(input=[query], model="pplx-embed-v1-4b")
  query_embedding = decode_embedding(query_response.data[0].embedding)

  # 3. Find most similar documents
  scores = [
      (i, cosine_similarity(query_embedding, doc_emb))
      for i, doc_emb in enumerate(doc_embeddings)
  ]
  ranked = sorted(scores, key=lambda x: x[1], reverse=True)

  print("Search results:")
  for idx, score in ranked:
      print(f"  {score:.4f}: {documents[idx]}")
  ```

  ```typescript TypeScript theme={null}
  import Perplexity from '@perplexity-ai/perplexity_ai';

  const client = new Perplexity();

  function decodeEmbedding(b64String: string): Int8Array {
      const buffer = Buffer.from(b64String, 'base64');
      return new Int8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  }

  function cosineSimilarity(a: Int8Array, b: Int8Array): number {
      let dotProduct = 0, normA = 0, normB = 0;
      for (let i = 0; i < a.length; i++) {
          dotProduct += a[i] * b[i];
          normA += a[i] * a[i];
          normB += b[i] * b[i];
      }
      return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  // 1. Embed your documents
  const documents = [
      "Python is a versatile programming language",
      "Machine learning automates analytical model building",
      "The Eiffel Tower is located in Paris, France"
  ];

  const docResponse = await client.embeddings.create({
      input: documents,
      model: "pplx-embed-v1-4b"
  });
  const docEmbeddings = docResponse.data!.map(emb => decodeEmbedding(emb.embedding!));

  // 2. Embed a search query
  const query = "What programming languages are good for data science?";
  const queryResponse = await client.embeddings.create({
      input: [query],
      model: "pplx-embed-v1-4b"
  });
  const queryEmbedding = decodeEmbedding(queryResponse.data![0].embedding!);

  // 3. Find most similar documents
  const scores = docEmbeddings.map((docEmb, i) => ({
      index: i,
      score: cosineSimilarity(queryEmbedding, docEmb)
  }));
  const ranked = scores.sort((a, b) => b.score - a.score);

  console.log("Search results:");
  for (const { index, score } of ranked) {
      console.log(`  ${score.toFixed(4)}: ${documents[index]}`);
  }
  ```
</CodeGroup>

## Parameters

| Parameter         | Type                     | Required |    Default    | Description                                                                                                                                              |
| ----------------- | ------------------------ | :------: | :-----------: | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `input`           | string \| array\[string] |    Yes   |       -       | Text(s) to embed. Max 512 texts per request. Each input must not exceed 32K tokens. Total tokens must not exceed 120,000. Empty strings are not allowed. |
| `model`           | string                   |    Yes   |       -       | Model identifier: `pplx-embed-v1-0.6b` or `pplx-embed-v1-4b`                                                                                             |
| `dimensions`      | integer                  |    No    |      Full     | Matryoshka dimension (128-1024 for 0.6b, 128-2560 for 4b)                                                                                                |
| `encoding_format` | string                   |    No    | `base64_int8` | Output encoding: `base64_int8` (signed int8) or `base64_binary` (packed bits)                                                                            |

<Warning>
  **Input limits:** Each text must not exceed 32K tokens. Requests exceeding this limit will be rejected. All inputs in a single request must not exceed 120,000 tokens combined.
</Warning>

## Related Resources

<CardGroup cols={2}>
  <Card title="Contextualized Embeddings" icon="file-lines" href="/docs/embeddings/contextualized-embeddings">
    Document-aware embeddings for chunks that share context.
  </Card>

  <Card title="Best Practices" icon="star" href="/docs/embeddings/best-practices">
    Batch processing, caching, and RAG patterns.
  </Card>
</CardGroup>