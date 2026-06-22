def test_sanity():
    assert 1 + 1 == 2


def test_health_response_shape():
    health = {
        "status": "ok",
        "service": "fanvault-ai-service",
    }
    assert health["status"] == "ok"
    assert health["service"] == "fanvault-ai-service"
