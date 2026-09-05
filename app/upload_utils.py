from fastapi import HTTPException, UploadFile

CHUNK_SIZE = 65536  # 64KB


async def read_upload_limited(file: UploadFile, max_bytes: int) -> bytes:
    """
    Reads an upload in chunks, aborting the instant the cumulative
    size exceeds max_bytes — rather than reading the whole file into
    memory first and only checking the size afterward. Caps how much
    memory a single oversized (or malicious) upload can consume.
    """
    chunks = []
    total = 0
    while True:
        chunk = await file.read(CHUNK_SIZE)
        if not chunk:
            break
        total += len(chunk)
        if total > max_bytes:
            raise HTTPException(status_code=400, detail=f"File must be under {max_bytes // (1024 * 1024)}MB")
        chunks.append(chunk)
    return b"".join(chunks)
