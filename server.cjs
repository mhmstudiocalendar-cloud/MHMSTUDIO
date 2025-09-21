/* server.cjs */
'use strict';

const express = require('express');
const cors = require('cors');
const { google } = require('googleapis');
const { DateTime } = require('luxon');
require('dotenv').config();

/* ===== Versão p/ debug rápido ===== */
const SERVER_VERSION = process.env.SERVER_VERSION || 'v1.2-idd-compat';

/* ===== Credenciais do serviço ===== */
const credentials = {
  type: process.env.GOOGLE_TYPE,
  project_id: process.env.GOOGLE_PROJECT_ID,
  private_key_id: process.env.GOOGLE_PRIVATE_KEY_ID,
  private_key: process.env.GOOGLE_PRIVATE_KEY
    ? process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n')
    : undefined,
  client_email: process.env.GOOGLE_CLIENT_EMAIL,
  client_id: process.env.GOOGLE_CLIENT_ID,
  auth_uri: process.env.GOOGLE_AUTH_URI,
  token_uri: process.env.GOOGLE_TOKEN_URI,
  auth_provider_x509_cert_url: process.env.GOOGLE_AUTH_PROVIDER_CERT_URL,
  client_x509_cert_url: process.env.GOOGLE_CLIENT_CERT_URL,
  universe_domain: process.env.GOOGLE_UNIVERSE_DOMAIN,
};

/* ===== Autenticação Google ===== */
const auth = new google.auth.GoogleAuth({
  credentials,
  scopes: ['https://www.googleapis.com/auth/calendar'],
});
const calendar = google.calendar({ version: 'v3', auth });

/* ===== App ===== */
const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.options('*', cors());

/* ===== Constantes ===== */
const CALENDAR_ID = 'mhmhairstudio@gmail.com';
const TIMEZONE = 'Europe/Lisbon';

const barbeiroColors = {
  'Cláudio Monteiro': '7',
  'André Henriques (CC)': '11',
};

/* ===== Rotas utilitárias ===== */
app.get('/', (_req, res) => res.send('Servidor do MHMSTUDIO está ativo 🚀'));
app.get('/health', (_req, res) => res.json({ ok: true }));
app.get('/version', (_req, res) =>
  res.json({ version: SERVER_VERSION, time: new Date().toISOString() })
);

/* ===== Criar evento (marcação) ===== */
app.post('/adicionar-evento', async (req, res) => {
  const {
    nome, numero, servico, barbeiro, data, hora,
    summary, description, start, end,
    durationMinutes, // 30 ou 60 (default 60)
  } = req.body;

  try {
    let evento = {};

    if (summary && description && start && end) {
      // payload já pronto
      const match = description.match(/Barbeiro:\s*(.+)/i);
      const nomeDoBarbeiro = match ? match[1].trim() : null;

      evento = {
        summary,
        description,
        start,
        end,
        colorId: nomeDoBarbeiro ? barbeiroColors[nomeDoBarbeiro] : undefined,
      };
    } else if (nome && servico && barbeiro && data && hora) {
      // construir a partir de dados simples
      const minutes = Number(durationMinutes) || 60;
      const startTime = DateTime.fromISO(`${data}T${hora}`, { zone: TIMEZONE });
      const endTime = startTime.plus({ minutes });

      evento = {
        summary: `${nome} - ${numero ? `${numero} - ` : ''}${servico}`,
        description: `Barbeiro: ${barbeiro}`,
        colorId: barbeiroColors[barbeiro],
        start: { dateTime: startTime.toISO(), timeZone: TIMEZONE },
        end:   { dateTime: endTime.toISO(),   timeZone: TIMEZONE },
      };
    } else {
      return res.status(400).json({ error: 'Dados em falta para criar o evento.' });
    }

    const response = await calendar.events.insert({
      calendarId: CALENDAR_ID,
      requestBody: evento,
      fields: 'id,htmlLink,iCalUID', // traz só o que precisamos
    });

    const { id, htmlLink, iCalUID } = response.data || {};
    if (!id) {
      console.error('Evento criado mas sem ID no payload:', response.data);
      return res.status(502).json({ error: 'Evento criado mas sem ID retornado pelo Google.' });
    }

    console.log('✅ Evento criado:', { id, iCalUID, htmlLink });

    // Normalização + compat: devolvemos sempre "id" e "iddamarcacao"
    return res.status(200).json({
      success: true,
      id,
      iddamarcacao: id, // compat com frontend
      iCalUID,
      eventLink: htmlLink,
    });
  } catch (error) {
    console.error('❌ Erro ao criar evento:', error?.response?.data || error);
    return res.status(500).json({ error: 'Erro ao criar evento no Google Calendar' });
  }
});

/* ===== Remover evento (aceita id ou iddamarcacao) ===== */
app.post('/remover-evento', async (req, res) => {
  try {
    const id = req.body.id || req.body.iddamarcacao;
    if (!id) return res.status(400).json({ error: 'Falta o id do evento Google Calendar' });

    await calendar.events.delete({ calendarId: CALENDAR_ID, eventId: id });
    return res.json({ success: true });
  } catch (error) {
    console.error('Erro ao remover evento do Google Calendar:', error?.response?.data || error);
    return res.status(500).json({ error: 'Erro ao remover evento do Google Calendar' });
  }
});

/* ===== Adicionar ausência ===== */
app.post('/adicionar-ausencia', async (req, res) => {
  try {
    const { nome, dataInicio, dataFim, hora } = req.body;
    if (!nome || !dataInicio) return res.status(400).json({ error: 'Dados insuficientes' });

    let evento;

    if (hora) {
      // ausência numa hora específica (+1h)
      const startDT = DateTime.fromISO(`${dataInicio}T${hora}`, { zone: TIMEZONE });
      const endDT = startDT.plus({ hours: 1 });
      evento = {
        summary: `Ausência - ${nome}`,
        description: `Ausência do barbeiro ${nome}`,
        start: { dateTime: startDT.toISO(), timeZone: TIMEZONE },
        end:   { dateTime: endDT.toISO(),   timeZone: TIMEZONE },
        colorId: '8',
      };
    } else {
      // all-day (end.date é exclusivo)
      const startDate = DateTime.fromISO(`${dataInicio}`, { zone: TIMEZONE }).startOf('day');
      const endBase   = DateTime.fromISO(`${dataFim || dataInicio}`, { zone: TIMEZONE }).startOf('day');
      const endDate   = endBase.plus({ days: 1 });

      evento = {
        summary: `Ausência - ${nome}`,
        description: `Ausência do barbeiro ${nome}`,
        start: { date: startDate.toISODate() },
        end:   { date: endDate.toISODate() },
        colorId: '8',
      };
    }

    const response = await calendar.events.insert({
      calendarId: CALENDAR_ID,
      requestBody: evento,
      fields: 'id,htmlLink,iCalUID',
    });

    const { id, htmlLink, iCalUID } = response.data || {};
    if (!id) {
      console.error('Ausência criada mas sem ID no payload:', response.data);
      return res.status(502).json({ error: 'Ausência criada mas sem ID retornado pelo Google.' });
    }

    console.log('✅ Ausência criada:', { id, iCalUID, htmlLink });

    return res.status(200).json({
      success: true,
      id,
      idAusencia: id,   // compat com UI de ausências
      iddamarcacao: id, // compat extra (se a UI reutilizar lógica)
      iCalUID,
      eventLink: htmlLink,
    });
  } catch (error) {
    console.error('❌ Erro ao adicionar ausência:', error?.response?.data || error);
    return res.status(500).json({ error: 'Erro ao adicionar ausência ao Google Calendar' });
  }
});

/* ===== Remover ausência (aceita id, idAusencia, iddamarcacao) ===== */
app.post('/remover-ausencia', async (req, res) => {
  try {
    const id = req.body.id || req.body.idAusencia || req.body.iddamarcacao;
    if (!id) return res.status(400).json({ error: 'Falta o id da ausência do Google Calendar' });

    await calendar.events.delete({ calendarId: CALENDAR_ID, eventId: id });
    return res.json({ success: true });
  } catch (error) {
    console.error('Erro ao remover ausência do Google Calendar:', error?.response?.data || error);
    return res.status(500).json({ error: 'Erro ao remover ausência do Google Calendar' });
  }
});

/* ===== Start server ===== */
const PORT = process.env.PORT || 8085;
app.listen(PORT, () => {
  console.log(`🚀 Servidor a correr na porta ${PORT} — ${SERVER_VERSION}`);
});
