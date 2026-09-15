"""Test-only JSON-lines bridge to Victor's real public MCP client; no model calls."""

import asyncio
import json
import os
from pathlib import Path
import sys

root = Path(os.environ["AGENTBROWSER_VICTOR_ROOT"]).resolve(strict=True)
sys.path.insert(0, str(root))
from victor.integrations.mcp import client as client_module

module_path = Path(client_module.__file__).resolve()
if module_path != root / "victor/integrations/mcp/client.py":
    raise RuntimeError("The requested Victor checkout was not imported")


async def main():
    client = client_module.MCPClient(health_check_interval=0, auto_reconnect=False)
    tasks = set()

    async def dispatch(request):
        try:
            method = request["method"]
            params = request.get("params", {})
            if method == "initialize":
                if not await client.connect([
                    os.environ["AGENTBROWSER_NODE"],
                    os.environ["AGENTBROWSER_MCP_BINARY"],
                ]):
                    raise RuntimeError("Victor could not initialize the built MCP server")
                result = {"harnessModule": str(module_path)}
            elif method == "tools/list":
                result = {"tools": [{"name": tool.name} for tool in await client.refresh_tools()]}
            elif method == "tools/call":
                call = await client.call_tool(params["name"], **params.get("arguments", {}))
                result = {
                    "content": [{"type": "text", "text": call.result or call.error or ""}],
                    "isError": not call.success,
                }
            else:
                raise ValueError("Unsupported diagnostic method")
            response = {"jsonrpc": "2.0", "id": request["id"], "result": result}
        except Exception as error:
            # Never print credentials or arbitrary request data in diagnostics.
            response = {"jsonrpc": "2.0", "id": request["id"], "error": {"message": type(error).__name__}}
        print(json.dumps(response), flush=True)

    try:
        while line := await asyncio.to_thread(sys.stdin.readline):
            # Preserve overlapping caller requests: Victor, rather than the bridge,
            # owns serialization of the real MCP connection. Bound diagnostic work.
            if len(tasks) >= 8:
                await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            task = asyncio.create_task(dispatch(json.loads(line)))
            tasks.add(task)
            task.add_done_callback(tasks.discard)
    finally:
        await asyncio.gather(*tasks)
        await client.cleanup()


asyncio.run(main())
