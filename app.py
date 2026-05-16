from flask import Flask, jsonify, request, render_template
import yfinance as yf
import pandas as pd
import numpy as np
import anthropic
import json
import os
import re
import requests as http_requests
from dotenv import load_dotenv
import warnings
warnings.filterwarnings('ignore')

load_dotenv()

app = Flask(__name__)
anthropic_client = anthropic.Anthropic(api_key=os.getenv('ANTHROPIC_API_KEY'))

# ─── Indicateurs techniques ───────────────────────────────────────────────────

def calculate_rsi(prices, period=14):
    delta = prices.diff()
    gain = delta.where(delta > 0, 0.0).rolling(window=period).mean()
    loss = (-delta.where(delta < 0, 0.0)).rolling(window=period).mean()
    rs = gain / loss.replace(0, np.nan)
    return 100 - (100 / (1 + rs))

def calculate_macd(prices, fast=12, slow=26, signal=9):
    ema_fast = prices.ewm(span=fast, adjust=False).mean()
    ema_slow = prices.ewm(span=slow, adjust=False).mean()
    macd_line = ema_fast - ema_slow
    signal_line = macd_line.ewm(span=signal, adjust=False).mean()
    histogram = macd_line - signal_line
    return macd_line, signal_line, histogram

def calculate_bollinger_bands(prices, window=20, num_std=2):
    mid = prices.rolling(window=window).mean()
    std = prices.rolling(window=window).std()
    return mid, mid + std * num_std, mid - std * num_std

def calculate_risk_metrics(returns):
    returns = returns.dropna()
    annual_return = float(returns.mean() * 252)
    annual_vol = float(returns.std() * np.sqrt(252))
    sharpe = annual_return / annual_vol if annual_vol > 0 else 0.0

    cumulative = (1 + returns).cumprod()
    rolling_max = cumulative.expanding().max()
    drawdown = (cumulative - rolling_max) / rolling_max
    max_dd = float(drawdown.min())

    var_95 = float(np.percentile(returns, 5))

    return {
        'annual_return': annual_return,
        'annual_volatility': annual_vol,
        'sharpe_ratio': sharpe,
        'max_drawdown': max_dd,
        'var_95': var_95,
    }

def safe_float(v, default=0.0):
    try:
        f = float(v)
        return default if (np.isnan(f) or np.isinf(f)) else f
    except Exception:
        return default

SECTOR_FR = {
    'Technology': 'Technologie',
    'Financial Services': 'Services financiers',
    'Healthcare': 'Santé',
    'Consumer Cyclical': 'Consommation discrétionnaire',
    'Consumer Defensive': 'Consommation de base',
    'Industrials': 'Industrie',
    'Basic Materials': 'Matériaux de base',
    'Energy': 'Énergie',
    'Utilities': 'Services aux collectivités',
    'Real Estate': 'Immobilier',
    'Communication Services': 'Services de communication',
    'Financial': 'Finance',
    'Consumer, Cyclical': 'Consommation discrétionnaire',
    'Consumer, Non-cyclical': 'Consommation de base',
}
INDUSTRY_FR = {
    'Semiconductors': 'Semi-conducteurs',
    'Software—Infrastructure': 'Logiciels infrastructure',
    'Software—Application': 'Logiciels applicatifs',
    'Internet Retail': 'Commerce en ligne',
    'Auto Manufacturers': 'Constructeurs automobiles',
    'Banks—Diversified': 'Banques diversifiées',
    'Banks—Regional': 'Banques régionales',
    'Drug Manufacturers—General': 'Fabricants de médicaments',
    'Oil & Gas Integrated': 'Pétrole & Gaz intégré',
    'Oil & Gas E&P': 'Pétrole & Gaz exploration',
    'Luxury Goods': 'Produits de luxe',
    'Specialty Chemicals': 'Chimie spécialisée',
    'Aerospace & Defense': 'Aérospatiale & Défense',
    'Telecom Services': 'Télécommunications',
    'Insurance—Diversified': 'Assurances diversifiées',
    'Asset Management': 'Gestion d\'actifs',
    'Discount Stores': 'Grands distributeurs',
    'Specialty Retail': 'Commerce spécialisé',
    'Entertainment': 'Divertissement',
    'Interactive Media & Services': 'Médias et services interactifs',
    'Consumer Electronics': 'Électronique grand public',
    'Personal Products': 'Produits personnels',
}

def fr_sector(v):
    return SECTOR_FR.get(v, v) if v else 'N/A'

def fr_industry(v):
    return INDUSTRY_FR.get(v, v) if v else 'N/A'

def safe_int(v, default=0):
    try:
        return int(v)
    except Exception:
        return default

def fmt_list(series):
    return [round(float(x), 4) if (x is not None and not np.isnan(float(x))) else None for x in series]

# ─── Routes ───────────────────────────────────────────────────────────────────

@app.route('/')
def index():
    return render_template('index.html')


@app.route('/api/stock/<ticker>')
def get_stock_data(ticker):
    ticker = ticker.upper().strip()
    period = request.args.get('period', '1y')

    try:
        stock = yf.Ticker(ticker)
        hist = stock.history(period=period, auto_adjust=True)

        if hist.empty:
            return jsonify({'error': f'Aucune donnée trouvée pour le ticker « {ticker} »'}), 404

        info = stock.info or {}
        hist['Returns'] = hist['Close'].pct_change()

        # Moving averages
        hist['MA20']  = hist['Close'].rolling(20).mean()
        hist['MA50']  = hist['Close'].rolling(50).mean()
        hist['MA200'] = hist['Close'].rolling(200).mean()

        rsi_series = calculate_rsi(hist['Close'])
        macd_line, signal_line, macd_hist = calculate_macd(hist['Close'])
        bb_mid, bb_up, bb_low = calculate_bollinger_bands(hist['Close'])

        risk = calculate_risk_metrics(hist['Returns'])

        # Beta
        beta = safe_float(info.get('beta'), 1.0)

        # Rendements sur différentes périodes
        n = len(hist)
        cur = float(hist['Close'].iloc[-1])
        p1w  = float(hist['Close'].iloc[max(-6,  -n)])
        p1m  = float(hist['Close'].iloc[max(-22, -n)])
        p3m  = float(hist['Close'].iloc[max(-63, -n)])
        p6m  = float(hist['Close'].iloc[max(-126,-n)])
        p1y  = float(hist['Close'].iloc[0])

        def ret(past): return round((cur - past) / past * 100, 2) if past else 0

        # Score de risque composite (0–10)
        vol = risk['annual_volatility']
        raw_risk = (min(vol * 100, 60) / 60) * 5 + (min(abs(beta), 3) / 3) * 3 + (min(abs(risk['max_drawdown']) * 100, 80) / 80) * 2
        risk_score = round(min(10, max(0, raw_risk)), 1)

        prev_close = safe_float(info.get('previousClose'), cur)

        chart = {
            'dates':       [d.strftime('%Y-%m-%d') for d in hist.index],
            'close':       [round(float(x), 2) for x in hist['Close']],
            'volume':      [safe_int(x) for x in hist['Volume']],
            'ma20':        fmt_list(hist['MA20']),
            'ma50':        fmt_list(hist['MA50']),
            'ma200':       fmt_list(hist['MA200']),
            'rsi':         fmt_list(rsi_series),
            'macd':        fmt_list(macd_line),
            'macd_signal': fmt_list(signal_line),
            'macd_hist':   fmt_list(macd_hist),
            'bb_upper':    fmt_list(bb_up),
            'bb_lower':    fmt_list(bb_low),
            'bb_mid':      fmt_list(bb_mid),
            'returns_pct': [round(float(x)*100,4) if x is not None and not np.isnan(float(x)) else None for x in hist['Returns']],
        }

        company = {
            'symbol':      ticker,
            'name':        info.get('longName') or info.get('shortName') or ticker,
            'sector':      fr_sector(info.get('sector', '')),
            'industry':    fr_industry(info.get('industry', '')),
            'country':     info.get('country', 'N/A'),
            'currency':    info.get('currency', 'USD'),
            'exchange':    info.get('exchange', 'N/A'),
            'website':     info.get('website', ''),
            'description': (info.get('longBusinessSummary') or '')[:600],
            'employees':   info.get('fullTimeEmployees', 'N/A'),
            'logo':        info.get('logo_url', ''),
        }

        financials = {
            'current_price':    round(cur, 2),
            'previous_close':   round(prev_close, 2),
            'day_change':       round(cur - prev_close, 2),
            'day_change_pct':   round((cur - prev_close) / prev_close * 100, 2) if prev_close else 0,
            'market_cap':       safe_int(info.get('marketCap'), 0),
            'pe_ratio':         round(safe_float(info.get('trailingPE')), 2),
            'forward_pe':       round(safe_float(info.get('forwardPE')), 2),
            'pb_ratio':         round(safe_float(info.get('priceToBook')), 2),
            'ps_ratio':         round(safe_float(info.get('priceToSalesTrailing12Months')), 2),
            'dividend_yield':   round(safe_float(info.get('dividendYield')), 2),
            'eps':              round(safe_float(info.get('trailingEps')), 2),
            'revenue':          safe_int(info.get('totalRevenue'), 0),
            'profit_margin':    round(safe_float(info.get('profitMargins')) * 100, 2),
            'roe':              round(safe_float(info.get('returnOnEquity')) * 100, 2),
            'roa':              round(safe_float(info.get('returnOnAssets')) * 100, 2),
            'debt_equity':      round(safe_float(info.get('debtToEquity')), 2),
            'current_ratio':    round(safe_float(info.get('currentRatio')), 2),
            'quick_ratio':      round(safe_float(info.get('quickRatio')), 2),
            'week52_high':      round(safe_float(info.get('fiftyTwoWeekHigh')), 2),
            'week52_low':       round(safe_float(info.get('fiftyTwoWeekLow')), 2),
            'avg_volume':       safe_int(info.get('averageVolume'), 0),
            'volume':           safe_int(hist['Volume'].iloc[-1]),
            'peg_ratio':        round(safe_float(info.get('pegRatio')), 2),
            'gross_margin':     round(safe_float(info.get('grossMargins')) * 100, 2),
            'ebitda_margin':    round(safe_float(info.get('ebitdaMargins')) * 100, 2),
            'free_cashflow':    safe_int(info.get('freeCashflow'), 0),
        }

        risk_perf = {
            'returns_1w':         ret(p1w),
            'returns_1m':         ret(p1m),
            'returns_3m':         ret(p3m),
            'returns_6m':         ret(p6m),
            'returns_1y':         ret(p1y),
            'annual_return':      round(risk['annual_return'] * 100, 2),
            'annual_volatility':  round(risk['annual_volatility'] * 100, 2),
            'sharpe_ratio':       round(risk['sharpe_ratio'], 2),
            'max_drawdown':       round(risk['max_drawdown'] * 100, 2),
            'var_95':             round(risk['var_95'] * 100, 2),
            'beta':               round(beta, 2),
            'risk_score':         risk_score,
            'current_rsi':        round(safe_float(rsi_series.iloc[-1], 50), 1),
            'current_macd':       round(safe_float(macd_line.iloc[-1]), 4),
            'macd_signal_val':    round(safe_float(signal_line.iloc[-1]), 4),
            'week52_position':    round(
                (cur - safe_float(info.get('fiftyTwoWeekLow'), cur)) /
                max(safe_float(info.get('fiftyTwoWeekHigh'), cur) - safe_float(info.get('fiftyTwoWeekLow'), cur), 0.01)
                * 100, 1),
        }

        return jsonify({'company': company, 'financials': financials, 'risk': risk_perf, 'chart': chart})

    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/ai-analysis/<ticker>')
def get_ai_analysis(ticker):
    ticker = ticker.upper().strip()
    period = request.args.get('period', '1y')

    try:
        stock = yf.Ticker(ticker)
        hist = stock.history(period=period, auto_adjust=True)
        if hist.empty:
            return jsonify({'error': f'Ticker introuvable : {ticker}'}), 404

        info = stock.info or {}
        hist['Returns'] = hist['Close'].pct_change()
        rsi = calculate_rsi(hist['Close'])
        macd_line, signal_line, _ = calculate_macd(hist['Close'])
        risk = calculate_risk_metrics(hist['Returns'])

        cur = float(hist['Close'].iloc[-1])
        beta = safe_float(info.get('beta'), 1.0)
        w52h = safe_float(info.get('fiftyTwoWeekHigh'), cur)
        w52l = safe_float(info.get('fiftyTwoWeekLow'), cur)

        d = {
            'company':       info.get('longName') or ticker,
            'ticker':        ticker,
            'sector':        fr_sector(info.get('sector', '')),
            'industry':      fr_industry(info.get('industry', '')),
            'currency':      info.get('currency', 'USD'),
            'price':         round(cur, 2),
            'mktcap':        safe_int(info.get('marketCap'), 0),
            'pe':            round(safe_float(info.get('trailingPE')), 2),
            'fwd_pe':        round(safe_float(info.get('forwardPE')), 2),
            'pb':            round(safe_float(info.get('priceToBook')), 2),
            'div_yield':     round(safe_float(info.get('dividendYield')), 2),
            'eps':           round(safe_float(info.get('trailingEps')), 2),
            'margin':        round(safe_float(info.get('profitMargins')) * 100, 2),
            'roe':           round(safe_float(info.get('returnOnEquity')) * 100, 2),
            'debt_eq':       round(safe_float(info.get('debtToEquity')), 2),
            'ann_ret':       round(risk['annual_return'] * 100, 2),
            'ann_vol':       round(risk['annual_volatility'] * 100, 2),
            'sharpe':        round(risk['sharpe_ratio'], 2),
            'drawdown':      round(risk['max_drawdown'] * 100, 2),
            'var95':         round(risk['var_95'] * 100, 2),
            'beta':          round(beta, 2),
            'rsi':           round(safe_float(rsi.iloc[-1], 50), 1),
            'macd':          round(safe_float(macd_line.iloc[-1]), 4),
            'macd_sig':      round(safe_float(signal_line.iloc[-1]), 4),
            'w52h':          round(w52h, 2),
            'w52l':          round(w52l, 2),
            'w52_pos':       round((cur - w52l) / max(w52h - w52l, 0.01) * 100, 1),
            'description':   (info.get('longBusinessSummary') or '')[:600],
        }

        prompt = f"""Tu es un analyste financier senior. Analyse l'action {d['company']} ({d['ticker']}) et fournis une analyse complète EN FRANÇAIS, adaptée à une investisseuse débutante.

DONNÉES FONDAMENTALES
━━━━━━━━━━━━━━━━━━━━
• Entreprise : {d['company']} ({d['ticker']}) | Secteur : {d['sector']} — {d['industry']}
• Prix actuel : {d['price']} {d['currency']} | Capitalisation : {d['mktcap']:,} {d['currency']}
• P/E : {d['pe']} (forward : {d['fwd_pe']}) | P/B : {d['pb']}
• Rendement dividende : {d['div_yield']}% | BPA : {d['eps']}
• Marge nette : {d['margin']}% | ROE : {d['roe']}% | Dette/FP : {d['debt_eq']}

PERFORMANCE & RISQUE
━━━━━━━━━━━━━━━━━━━
• Rendement annualisé : {d['ann_ret']}%
• Volatilité annualisée : {d['ann_vol']}%
• Ratio de Sharpe : {d['sharpe']}
• Drawdown maximum : {d['drawdown']}%
• VaR 95% (perte max journalière) : {d['var95']}%
• Bêta (sensibilité au marché) : {d['beta']}

INDICATEURS TECHNIQUES
━━━━━━━━━━━━━━━━━━━━━
• RSI 14j : {d['rsi']} (>70 = suracheté, <30 = survendu)
• MACD : {d['macd']} | Signal : {d['macd_sig']}
• 52 semaines : bas {d['w52l']} → haut {d['w52h']}
• Position dans le range annuel : {d['w52_pos']}%

DESCRIPTION
━━━━━━━━━━━
{d['description']}

Réponds UNIQUEMENT avec un objet JSON valide (aucun texte avant ou après) avec exactement ces champs :
{{
  "recommendation": "ACHETER" | "CONSERVER" | "VENDRE",
  "score_conviction": <entier 1-10>,
  "horizon": "Court terme (< 3 mois)" | "Moyen terme (3-12 mois)" | "Long terme (> 1 an)",
  "niveau_risque": "FAIBLE" | "MODÉRÉ" | "ÉLEVÉ" | "TRÈS ÉLEVÉ",
  "resume": "<2-3 phrases claires résumant la situation>",
  "points_forts": ["<force 1>", "<force 2>", "<force 3>"],
  "points_faibles": ["<faiblesse 1>", "<faiblesse 2>", "<faiblesse 3>"],
  "analyse_technique": "<2-3 phrases sur les signaux techniques>",
  "analyse_fondamentale": "<2-3 phrases sur la valorisation et la santé financière>",
  "analyse_risque": "<2-3 phrases expliquant les risques de façon simple>",
  "catalyseurs": ["<catalyseur haussier 1>", "<catalyseur haussier 2>"],
  "risques_cles": ["<risque 1>", "<risque 2>"],
  "prix_cible_bas": <nombre>,
  "prix_cible_haut": <nombre>,
  "conseil_debutant": "<conseil pratique et bienveillant pour une débutante, en 2-3 phrases simples>",
  "position_portefeuille": "<quelle part maximale du portefeuille allouer et pourquoi>"
}}"""

        message = anthropic_client.messages.create(
            model='claude-sonnet-4-6',
            max_tokens=2048,
            messages=[{'role': 'user', 'content': prompt}],
        )

        raw = message.content[0].text.strip()
        try:
            analysis = json.loads(raw)
        except json.JSONDecodeError:
            m = re.search(r'\{.*\}', raw, re.DOTALL)
            analysis = json.loads(m.group()) if m else {'error': 'Réponse IA invalide', 'raw': raw}

        return jsonify(analysis)

    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/compare')
def compare_stocks():
    raw = request.args.get('tickers', '')
    tickers = [t.strip().upper() for t in raw.split(',') if t.strip()][:6]
    if len(tickers) < 2:
        return jsonify({'error': 'Veuillez fournir au moins 2 tickers séparés par des virgules'}), 400

    results = []
    for tkr in tickers:
        try:
            stock = yf.Ticker(tkr)
            hist = stock.history(period='1y', auto_adjust=True)
            if hist.empty:
                continue
            info = stock.info or {}
            hist['Returns'] = hist['Close'].pct_change()
            risk = calculate_risk_metrics(hist['Returns'])
            cur = float(hist['Close'].iloc[-1])
            start = float(hist['Close'].iloc[0])
            results.append({
                'ticker':           tkr,
                'name':             info.get('longName') or info.get('shortName') or tkr,
                'current_price':    round(cur, 2),
                'currency':         info.get('currency', 'USD'),
                'ytd_return':       round((cur - start) / start * 100, 2),
                'annual_vol':       round(risk['annual_volatility'] * 100, 2),
                'sharpe':           round(risk['sharpe_ratio'], 2),
                'beta':             round(safe_float(info.get('beta'), 1.0), 2),
                'pe':               round(safe_float(info.get('trailingPE')), 2),
                'div_yield':        round(safe_float(info.get('dividendYield')), 2),
                'max_drawdown':     round(risk['max_drawdown'] * 100, 2),
                'chart_close':      [round(float(x), 2) for x in hist['Close'].tolist()[-52:]],
                'chart_dates':      [d.strftime('%Y-%m-%d') for d in hist.index[-52:]],
            })
        except Exception:
            continue

    return jsonify(results)


@app.route('/api/search')
def search_companies():
    q = request.args.get('q', '').strip()
    if not q or len(q) < 2:
        return jsonify([])
    try:
        url = (
            'https://query1.finance.yahoo.com/v1/finance/search'
            f'?q={q}&quotesCount=10&newsCount=0&listsCount=0'
            '&enableFuzzyQuery=true&enableEnhancedTrivialQuery=true'
        )
        headers = {'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'}
        resp = http_requests.get(url, headers=headers, timeout=5)
        data = resp.json()
        results = []
        for item in data.get('quotes', []):
            if item.get('quoteType') not in ('EQUITY', 'ETF', 'INDEX', 'MUTUALFUND'):
                continue
            type_labels = {
                'EQUITY': 'Action', 'ETF': 'ETF',
                'INDEX': 'Indice', 'MUTUALFUND': 'Fonds',
            }
            results.append({
                'symbol':   item.get('symbol', ''),
                'name':     item.get('longname') or item.get('shortname') or item.get('symbol', ''),
                'exchange': item.get('exchDisp') or item.get('exchange', ''),
                'type':     type_labels.get(item.get('quoteType', ''), item.get('quoteType', '')),
            })
        return jsonify(results[:8])
    except Exception as e:
        return jsonify([])


if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5001))
    app.run(debug=True, port=port)
