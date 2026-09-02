from fastapi.testclient import TestClient
from app.main import app

client = TestClient(app)
def test_health(): assert client.get('/health').json()['status'] == 'ok'
def test_market_boundaries():
    data = client.get('/api/v1/market/gold').json()
    assert 0 <= data['bull_bear_score'] <= 100 and data['delayed'] is True
def test_search_limit_and_empty():
    assert client.get('/api/v1/search?q=金').status_code == 200
    assert client.get('/api/v1/search?q=').status_code == 422
def test_change_types():
    types = {x['type'] for x in client.get('/api/v1/changes/gold').json()['items']}
    assert {'added','sentiment_changed','strategy_adjusted'} <= types
