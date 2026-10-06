# JSONBin Python SDK

Official zero-dependency Python client for JSONBin.

## Installation

```bash
pip install jsonbin-client
```

## Quick Start

```python
from jsonbin_client import JsonBin

client = JsonBin(base_url="https://js.gnn.im", token="jb_live_...")

# Create Bin
bin = client.bins.create(name="App Config", value={"debug": True, "port": 8080})

# Get Bin
res = client.bins.get(bin["meta"]["id"])

# JSON Patch (RFC 6902)
patched = client.bins.json_patch(
    bin["meta"]["id"],
    [{"op": "replace", "path": "/port", "value": 9000}],
    etag=res["etag"]
)
```
