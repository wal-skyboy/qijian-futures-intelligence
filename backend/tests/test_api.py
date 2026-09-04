from fastapi.testclient import TestClient
from app.main import app

client = TestClient(app)
def test_health(): assert client.get('/health').json()['status'] == 'ok'
def test_market_boundaries():
    data = client.get('/api/v1/market/gold').json()
    assert 0 <= data['bull_bear_score'] <= 100 and data['delayed'] is True
def test_search_limit_and_empty():
    assert client.get('/api/v1/search?q=金').status_code == 200
    assert any(item['name'] == '铜' for item in client.get('/api/v1/search?q=铜').json())
    assert client.get('/api/v1/search?q=').status_code == 422
def test_change_types():
    types = {x['type'] for x in client.get('/api/v1/changes/gold').json()['items']}
    assert {'added','sentiment_changed','strategy_adjusted'} <= types
def test_global_market_and_strategy():
    global_data = client.get('/api/v1/market/global').json()
    assert len(global_data['items']) == 6
    assert {'gold','silver','copper','tin','crude','usd'} <= {item['symbol'] for item in global_data['items']}
    plan = client.get('/api/v1/strategy/gold').json()
    assert plan['bias'] in {'偏多','偏空','中性'} and 0 <= plan['score'] <= 100
def test_image_analysis_contract():
    response = client.post('/api/v1/image-analysis', json={
        'file_name':'chart.png','mime_type':'image/png','size_bytes':1024,
        'width':1280,'height':720,'asset':'silver'})
    data = response.json()
    assert response.status_code == 200 and data['provider'] == 'demo_vision'
    assert data['signals'] and 'silver' not in data['title'].lower()

def test_focus_market_search_and_modes():
    names = {item['name'] for item in client.get('/api/v1/search?q=美').json()}
    assert '美元' in names
    usd = client.get('/api/v1/market/usd').json()
    assert usd['data_mode'] in {'demo_fallback_no_key', 'fx_realtime', 'fallback_provider_error'}
