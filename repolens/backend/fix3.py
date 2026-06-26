with open('vectorstore.py', 'r') as f:
    content = f.read()

old = 'import re\n\nimport chromadb\n\n# Module-level persistent client - reused across all calls\n_client = chromadb.PersistentClient(path="./chroma_data")'

new = 'import os\nimport re\n\nimport chromadb\n\n# Absolute path so ChromaDB works regardless of where uvicorn is launched from\n_DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "chroma_data")\n_client = chromadb.PersistentClient(path=_DB_PATH)'

if old in content:
    content = content.replace(old, new)
    with open('vectorstore.py', 'w') as f:
        f.write(content)
    print('Fix applied successfully.')
else:
    print('Pattern not found - showing first 300 chars of file:')
    print(repr(content[:300]))
