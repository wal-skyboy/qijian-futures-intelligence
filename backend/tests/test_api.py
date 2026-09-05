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
def test_market_board_sync_contract():
    board = client.get('/api/v1/market/board')
    data = board.json()
    assert board.status_code == 200
    assert len(data['items']) == 6
    assert data['sync']['refresh_mode'] == 'polling'
    assert data['sync']['item_count'] == 6
    assert data['sync']['latency_ms'] >= 0
def test_market_candles_contract():
    response = client.get('/api/v1/market/gold/candles?interval=daily')
    data = response.json()
    assert response.status_code == 200
    assert data['symbol'] == 'gold' and data['interval'] == 'daily'
    assert len(data['candles']) >= 30
    assert all({'time','open','high','low','close'} <= set(row) for row in data['candles'])
def test_image_analysis_contract():
    response = client.post('/api/v1/image-analysis', json={
        'file_name':'chart.png','mime_type':'image/png','size_bytes':1024,
        'width':1280,'height':720,'asset':'silver'})
    data = response.json()
    assert response.status_code in {200, 503}
    assert data['provider'] == 'openai_vision'
    if response.status_code == 503:
        assert data['analysis_status'] == 'not_configured'
        assert data['received'] is False
    else:
        assert data['received'] is True and data['analysis_status'] == 'complete'
        assert data['items'] and data['items'][0]['facts'] is not None

def test_focus_market_search_and_modes():
    names = {item['name'] for item in client.get('/api/v1/search?q=美').json()}
    assert '美元' in names
    usd = client.get('/api/v1/market/usd').json()
    assert usd['data_mode'] in {'demo_fallback_no_key', 'fx_realtime', 'fallback_provider_error'}

def test_focus_market_freshness_contract():
    data = client.get('/api/v1/market/global').json()
    modes = {item['symbol']: item['data_mode'] for item in data['items']}
    assert modes['gold'] in {'demo_fallback_no_key', 'spot_realtime', 'fallback_provider_error'}
    assert modes['silver'] in {'demo_fallback_no_key', 'spot_realtime', 'fallback_provider_error'}
    assert modes['usd'] in {'demo_fallback_no_key', 'fx_realtime', 'fallback_provider_error'}
    assert modes['copper'] in {'demo_fallback_no_key', 'daily_reference', 'fallback_provider_error'}
    assert modes['crude'] in {'demo_fallback_no_key', 'daily_reference', 'fallback_provider_error'}
    assert modes['tin'] == 'licensed_delayed_required' or modes['tin'] == 'demo_fallback_no_key'
