// server.cjs
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const { google } = require('googleapis');
const { DateTime } = require('luxon');

const app = express();
app.use(cors());
app.use(express.json());

// ---------- Credenciais Google ----------
const PRIVATE_KEY_RAW = process.env.GOOGLE_PRIVATE_KEY || '';
const PRIVATE_KEY = PRIVATE_KEY_RAW.includes('\\n')
  ? PRIVATE_KEY_RAW.replace(/\\n/g, '\n')
  : PRIVATE_KEY_RAW;

const credentials = {
  type: process.env.GOOGLE_TYPE,
  project_id: process.env.GOOGLE_PROJECT_ID,
  private_key_id: process.env.GOOGLE_PRIVATE_KEY_ID,
  private_key: PRIVATE_KEY,
  client_email: process.env.GOOGLE_CLIENT_EMAIL,
  client_id: process.env.GOOGLE_CLIENT_ID,
  auth_uri: process.env.GOOGLE_AUTH_URI,
  token_uri: process.env.GOOGLE_TOKEN_URI,
  auth_provider_x509_cert_url: process.env.GOOGLE_AUTH_PROVIDER_CERT_URL,
  client_x509_cert_url: process.env.GOOGLE_CLIENT_CERT_URL,
  universe_domain: process.env.GOOGLE_UNIVERSE_DOMAIN,
};

const auth = new google.auth.GoogleAuth({
  credentials,
  scopes: ['https://www.googleapis.com/auth/calendar'],
});

const calendar = google.calendar({ version: 'v3', auth });
const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID || 'mhmhairstudio@gmail.com';

// ---------- Utils ----------
const logGoogleError = (err) => {
  const payload = err?.response?.data || err?.message || err;
  console.error('Google API error ->', payload);
};

// ---------- Health ----------
app.get('/', (_req, res) => {
  res.send('Servidor do MHMSTUDIO está ativo 🚀');
});

// ---------- Criar evento ----------
app.post('/adicionar-evento', async (req, res) => {
  try {
    const {
      // payload “modo antigo”
      nome, numero, servico, barbeiro, data, hora,
      // payload “modo direto”
      summary, description, start, end,
      // comuns
      durationMinutes,              // opcional (30/60/90…); default 60
      bookingId,                    // <- ID local da marcação (recomendado)
      iddamarcacao,                 // <- se estiveres a usar este campo como “id local”, também o aceito
    } = req.body;

    // map de cores por barbeiro (opcional)
    const barbeiroColors = {
      'Cláudio Monteiro': '7',
      'André Henriques (CC)': '11',
    };

    // normalizar um possível ID local vindo do front
    const localId = bookingId || iddamarcacao ? String(bookingId || iddamarcacao) : undefined;

    let eventBody = {};

    if (summary && description && start && end) {
      // modo direto
      const match = typeof description === 'string' ? description.match(/Barbeiro:\s*(.+)/) : null;
      const nomeDoBarbeiro = match ? match[1].trim() : null;

      eventBody = {
        summary,
        description,
        start,
        end,
        colorId: nomeDoBarbeiro ? barbeiroColors[nomeDoBarbeiro] : undefined,
        ...(localId ? { extendedProperties: { private: { bookingId: localId } } } : {}),
      };
    } else if (nome && servico && barbeiro && data && hora) {
      // modo antigo
      const minutes = Number(durationMinutes) || 60; // fallback 60
      const startTime = DateTime.fromISO(`${data}T${hora}`, { zone: 'Europe/Lisbon' });
      const endTime = startTime.plus({ minutes });

      eventBody = {
        summary: `${nome} - ${numero ? numero + ' - ' : ''}${servico}`,
        description: `Barbeiro: ${barbeiro}`,
        colorId: barbeiroColors[barbeiro],
        start: { dateTime: startTime.toISO(), timeZone: 'Europe/Lisbon' },
        end:   { dateTime: endTime.toISO(),   timeZone: 'Europe/Lisbon' },
        ...(localId ? { extendedProperties: { private: { bookingId: localId } } } : {}),
      };
    } else {
      return res.status(400).json({ error: 'Dados em falta para criar o evento.' });
    }

    const response = await calendar.events.insert({
      calendarId: CALENDAR_ID,
      requestBody: eventBody,
    });

    const googleEventId = response.data.id;

    return res.status(200).json({
      success: true,
      eventLink: response.data.htmlLink,
      iddamarcacao: googleEventId,  // <- ID REAL do Google Calendar
      bookingId: localId || null,   // <- o ID local que recebemos (se houver)
    });
  } catch (error) {
    logGoogleError(error);
    return res.status(500).json({ error: 'Erro ao criar evento no Google Calendar' });
  }
});

// ---------- Remover evento (por eventId OU bookingId) ----------
app.post('/remover-evento', async (req, res) => {
  try {
    // aceito vários nomes para compatibilidade
    const {
      iddamarcacao,     // pode ser o eventId do Google OU (anteriormente) usado como id local
      eventId,
      googleEventId,
      bookingId,        // id local
    } = req.body;

    const directId = String(eventId || googleEventId || iddamarcacao || '').trim();
    const localId = String(bookingId || '').trim();

    // 1) Tenta apagar diretamente por eventId do Google
    if (directId) {
      try {
        await calendar.events.delete({ calendarId: CALENDAR_ID, eventId: directId });
        return res.json({ success: true, deleted: 1, mode: 'byEventId' });
      } catch (err) {
        // não retornamos ainda; caímos para busca por bookingId
        // console.warn('Delete direto falhou, tentar por bookingId...', err?.response?.data || err?.message);
      }
    }

    // 2) Se veio um bookingId (id local), procurar por extendedProperties.private.bookingId
    if (!localId) {
      return res.status(400).json({ error: 'Falta o id do evento (Google) ou bookingId local' });
    }

    const listResp = await calendar.events.list({
      calendarId: CALENDAR_ID,
      privateExtendedProperty: `bookingId=${localId}`,
      maxResults: 2500,
      singleEvents: true,
      orderBy: 'startTime',
    });

    const items = listResp.data.items || [];
    if (!items.length) {
      return res.status(404).json({ error: 'Evento não encontrado (nem por eventId, nem por bookingId).' });
    }

    let deleted = 0;
    for (const ev of items) {
      try {
        await calendar.events.delete({ calendarId: CALENDAR_ID, eventId: ev.id });
        deleted++;
      } catch (errDel) {
        logGoogleError(errDel);
      }
    }

    return res.json({ success: true, deleted, mode: 'byBookingId' });
  } catch (error) {
    logGoogleError(error);
    return res.status(500).json({ error: 'Erro ao remover evento do Google Calendar' });
  }
});

// ---------- Adicionar ausência ----------
app.post('/adicionar-ausencia', async (req, res) => {
  try {
    const { nome, dataInicio, dataFim, hora, durationMinutes } = req.body;

    if (!nome || !dataInicio) {
      return res.status(400).json({ error: 'Dados insuficientes' });
    }

    const tz = 'Europe/Lisbon';
    let eventBody;

    if (hora) {
      // ausência em hora específica — por defeito 60m; podes enviar durationMinutes=30 para 30m
      const minutes = Number(durationMinutes) || 60;
      const startTime = DateTime.fromISO(`${dataInicio}T${hora}`, { zone: tz });
      const endTime = startTime.plus({ minutes });

      eventBody = {
        summary: `Ausência - ${nome}`,
        description: `Ausência do barbeiro ${nome}`,
        start: { dateTime: startTime.toISO(), timeZone: tz },
        end:   { dateTime: endTime.toISO(),   timeZone: tz },
        colorId: '8',
      };
    } else {
      // All-day: end.date = (dataFim || dataInicio) + 1 dia
      const startDate = new Date(`${dataInicio}T00:00:00`);
      const endDateBase = new Date(`${(dataFim || dataInicio)}T00:00:00`);
      const endDate = new Date(endDateBase.getTime() + 24 * 60 * 60 * 1000);

      const toISODate = (d) => d.toISOString().slice(0, 10);

      eventBody = {
        summary: `Ausência - ${nome}`,
        description: `Ausência do barbeiro ${nome}`,
        start: { date: toISODate(startDate) },
        end:   { date: toISODate(endDate) },
        colorId: '8',
      };
    }

    const response = await calendar.events.insert({
      calendarId: CALENDAR_ID,
      requestBody: eventBody,
    });

    const idAusencia = response.data.id;
    return res.status(200).json({
      success: true,
      eventLink: response.data.htmlLink,
      idAusencia,
    });
  } catch (error) {
    logGoogleError(error);
    return res.status(500).json({ error: 'Erro ao adicionar ausência ao Google Calendar' });
  }
});

// ---------- Remover ausência ----------
app.post('/remover-ausencia', async (req, res) => {
  try {
    const { idAusencia } = req.body;
    if (!idAusencia) {
      return res.status(400).json({ error: 'Falta o id do ausencia Google Calendar' });
    }

    await calendar.events.delete({
      calendarId: CALENDAR_ID,
      eventId: idAusencia,
    });

    return res.json({ success: true });
  } catch (error) {
    logGoogleError(error);
    return res.status(500).json({ error: 'Erro ao remover ausencia do Google Calendar' });
  }
});

// ---------- Start ----------
const PORT = process.env.PORT || 8085;
app.listen(PORT, () => {
  console.log(`🚀 Servidor a correr na porta ${PORT}`);
});
