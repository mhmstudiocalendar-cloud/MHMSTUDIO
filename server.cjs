'use strict';

const express = require('express');
const cors = require('cors');
const { google } = require('googleapis');
const { DateTime } = require('luxon');
require('dotenv').config();

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
app.use(cors());
app.use(express.json());

/* ===== Helpers ===== */
const CALENDAR_ID = 'mhmhairstudio@gmail.com';
const TIMEZONE = 'Europe/Lisbon';

const barbeiroColors = {
  'Cláudio Monteiro': '7',
  'André Henriques (CC)': '11',
};

/* ===== Rota de saúde/raiz ===== */
app.get('/', (_req, res) => {
  res.send('Servidor do MHMSTUDIO está ativo 🚀');
});
app.get('/health', (_req, res) => res.json({ ok: true }));

/* ===== Criar evento (marcação) ===== */
app.post('/adicionar-evento', async (req, res) => {
  const {
    nome, numero, servico, barbeiro, data, hora,
    summary, description, start, end,
    durationMinutes, // 30 ou 60 (default 60)
    bookingType, // Tipos de marcação: individual | familiar
    secondPersonInfo, // Informações do segundo cliente (para marcações familiares)
    secondPersonBarber, // Barbeiro do segundo cliente
  } = req.body;

  try {
    let evento = {};

    if (summary && description && start && end) {
      // Se um resumo e descrição forem passados, assume-se que são informações completas para o evento
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
      const minutes = Number(durationMinutes) || 60;
      const startTime = DateTime.fromISO(`${data}T${hora}`, { zone: TIMEZONE });
      const endTime = startTime.plus({ minutes });

      // Caso seja uma marcação individual, cria o evento normal
      evento = {
        summary: `${nome} - ${numero ? `${numero} - ` : ''}${servico}`,
        description: `Barbeiro: ${barbeiro}`,
        colorId: barbeiroColors[barbeiro],
        start: { dateTime: startTime.toISO(), timeZone: TIMEZONE },
        end:   { dateTime: endTime.toISO(),   timeZone: TIMEZONE },
      };

      if (bookingType === 'familiar') {
        // Se for uma marcação familiar, criamos um evento para o segundo barbeiro
        const secondStartTime = DateTime.fromISO(`${data}T${hora}`, { zone: TIMEZONE });
        const secondEndTime = secondStartTime.plus({ minutes });

        const secondEvento = {
          summary: `${secondPersonInfo.name} - ${secondPersonInfo.phone ? `${secondPersonInfo.phone} - ` : ''}${servico}`,
          description: `Barbeiro: ${secondPersonBarber}`,
          colorId: barbeiroColors[secondPersonBarber],
          start: { dateTime: secondStartTime.toISO(), timeZone: TIMEZONE },
          end:   { dateTime: secondEndTime.toISO(),   timeZone: TIMEZONE },
        };

        // Criar evento para o segundo barbeiro
        const secondResponse = await calendar.events.insert({
          calendarId: CALENDAR_ID,
          requestBody: secondEvento,
          fields: 'id,htmlLink,iCalUID',
        });

        const { id: secondId, htmlLink: secondLink, iCalUID: secondIcalUID } = secondResponse.data || {};
        if (!secondId) {
          console.error('Evento para o segundo cliente criado mas sem ID no payload:', secondResponse.data);
          return res.status(502).json({ error: 'Evento do segundo cliente criado mas sem ID retornado pelo Google.' });
        }

        console.log('✅ Evento do segundo cliente criado:', { secondId, secondIcalUID, secondLink });
      }
    } else {
      return res.status(400).json({ error: 'Dados em falta para criar o evento.' });
    }

    // Criar evento no Google Calendar
    const response = await calendar.events.insert({
      calendarId: CALENDAR_ID,
      requestBody: evento,
      fields: 'id,htmlLink,iCalUID',
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
      iddamarcacao: id,      // compat com o teu frontend atual
      iCalUID,
      eventLink: htmlLink,
    });
  } catch (error) {
    console.error('❌ Erro ao criar evento:', error?.response?.data || error);
    return res.status(500).json({ error: 'Erro ao criar evento no Google Calendar' });
  }
});

/* ===== Remover evento (compatível id/iddamarcacao) ===== */
app.post('/remover-evento', async (req, res) => {
  try {
    const id = req.body.id || req.body.iddamarcacao;
    if (!id) {
      return res.status(400).json({ error: 'Falta o id do evento Google Calendar' });
    }

    await calendar.events.delete({
      calendarId: CALENDAR_ID,
      eventId: id,
    });

    return res.json({ success: true });
  } catch (error) {
    console.error('Erro ao remover evento do Google Calendar:', error?.response?.data || error);
    return res.status(500).json({ error: 'Erro ao remover evento do Google Calendar' });
  }
});

/* ===== Adicionar ausência ===== */
app.post('/adicionar-evento', async (req, res) => {
  const {
    nome, numero, servico, barbeiro, data, hora,
    summary, description, start, end,
    durationMinutes, // 30 ou 60 (default 60)
    bookingType, // Tipos de marcação: individual | familiar
    secondPersonInfo, // Informações do segundo cliente (para marcações familiares)
    secondPersonBarber, // Barbeiro do segundo cliente
  } = req.body;

  try {
    let evento = {};

    console.log('Recebido:', {
      nome, numero, servico, barbeiro, data, hora,
      summary, description, start, end,
      durationMinutes, bookingType, secondPersonInfo, secondPersonBarber
    });

    // Se a descrição e os horários estiverem completos
    if (summary && description && start && end) {
      const match = description.match(/Barbeiro:\s*(.+)/i);
      const nomeDoBarbeiro = match ? match[1].trim() : null;

      evento = {
        summary,
        description,
        start,
        end,
        colorId: nomeDoBarbeiro ? barbeiroColors[nomeDoBarbeiro] : undefined,
      };

      console.log('Evento com dados completos:', evento);
    } else if (nome && servico && barbeiro && data && hora) {
      const minutes = Number(durationMinutes) || 60;
      const startTime = DateTime.fromISO(`${data}T${hora}`, { zone: TIMEZONE });
      const endTime = startTime.plus({ minutes });

      // Caso seja uma marcação individual, cria o evento normal
      evento = {
        summary: `${nome} - ${numero ? `${numero} - ` : ''}${servico}`,
        description: `Barbeiro: ${barbeiro}`,
        colorId: barbeiroColors[barbeiro],
        start: { dateTime: startTime.toISO(), timeZone: TIMEZONE },
        end:   { dateTime: endTime.toISO(),   timeZone: TIMEZONE },
      };

      console.log('Evento para o primeiro cliente:', evento);

      if (bookingType === 'familiar') {
        console.log('Criando eventos para uma marcação familiar...');

        // Primeiro cliente
        const firstStartTime = DateTime.fromISO(`${data}T${hora}`, { zone: TIMEZONE });
        const firstEndTime = firstStartTime.plus({ minutes });

        const firstEvento = {
          summary: `${nome} - ${numero ? `${numero} - ` : ''}${servico}`,
          description: `Barbeiro: ${barbeiro}`,
          colorId: barbeiroColors[barbeiro],
          start: { dateTime: firstStartTime.toISO(), timeZone: TIMEZONE },
          end:   { dateTime: firstEndTime.toISO(),   timeZone: TIMEZONE },
        };

        console.log('Criando evento para o primeiro cliente:', firstEvento);

        // Criar evento para o primeiro cliente
        const firstResponse = await calendar.events.insert({
          calendarId: CALENDAR_ID,
          requestBody: firstEvento,
          fields: 'id,htmlLink,iCalUID',
        });

        const { id: firstId, htmlLink: firstLink, iCalUID: firstIcalUID } = firstResponse.data || {};
        if (!firstId) {
          console.error('Evento do primeiro cliente criado mas sem ID no payload:', firstResponse.data);
          return res.status(502).json({ error: 'Evento do primeiro cliente criado mas sem ID retornado pelo Google.' });
        }

        console.log('✅ Evento do primeiro cliente criado:', { firstId, firstIcalUID, firstLink });

        // Agora, criamos o evento para o segundo cliente
        const secondStartTime = DateTime.fromISO(`${data}T${hora}`, { zone: TIMEZONE });
        const secondEndTime = secondStartTime.plus({ minutes });

        const secondEvento = {
          summary: `${secondPersonInfo.name} - ${secondPersonInfo.phone ? `${secondPersonInfo.phone} - ` : ''}${servico}`,
          description: `Barbeiro: ${secondPersonBarber}`, // Garantir que o barbeiro correto é passado
          colorId: barbeiroColors[secondPersonBarber], // Atribuindo o barbeiro correto para o segundo cliente
          start: { dateTime: secondStartTime.toISO(), timeZone: TIMEZONE },
          end:   { dateTime: secondEndTime.toISO(),   timeZone: TIMEZONE },
        };

        console.log('Criando evento para o segundo cliente:', secondEvento);

        // Criar evento para o segundo cliente
        const secondResponse = await calendar.events.insert({
          calendarId: CALENDAR_ID,
          requestBody: secondEvento,
          fields: 'id,htmlLink,iCalUID',
        });

        const { id: secondId, htmlLink: secondLink, iCalUID: secondIcalUID } = secondResponse.data || {};
        if (!secondId) {
          console.error('Evento para o segundo cliente criado mas sem ID no payload:', secondResponse.data);
          return res.status(502).json({ error: 'Evento do segundo cliente criado mas sem ID retornado pelo Google.' });
        }

        console.log('✅ Evento do segundo cliente criado:', { secondId, secondIcalUID, secondLink });
      }
    } else {
      return res.status(400).json({ error: 'Dados em falta para criar o evento.' });
    }

    // Criar evento no Google Calendar para o primeiro cliente
    const response = await calendar.events.insert({
      calendarId: CALENDAR_ID,
      requestBody: evento,
      fields: 'id,htmlLink,iCalUID',
    });

    const { id, htmlLink, iCalUID } = response.data || {};
    if (!id) {
      console.error('Evento criado mas sem ID no payload:', response.data);
      return res.status(502).json({ error: 'Evento criado mas sem ID retornado pelo Google.' });
    }

    console.log('✅ Evento criado para o primeiro cliente:', { id, iCalUID, htmlLink });

    // Normalização + compat: devolvemos sempre "id" e "iddamarcacao"
    return res.status(200).json({
      success: true,
      id,
      iddamarcacao: id,      // compat com o teu frontend atual
      iCalUID,
      eventLink: htmlLink,
    });
  } catch (error) {
    console.error('❌ Erro ao criar evento:', error?.response?.data || error);
    return res.status(500).json({ error: 'Erro ao criar evento no Google Calendar' });
  }
});

/* ===== Remover ausência (compatível id/idAusencia) ===== */
app.post('/remover-ausencia', async (req, res) => {
  try {
    const id = req.body.id || req.body.idAusencia;
    if (!id) {
      return res.status(400).json({ error: 'Falta o id da ausência do Google Calendar' });
    }

    await calendar.events.delete({
      calendarId: CALENDAR_ID,
      eventId: id,
    });

    return res.json({ success: true });
  } catch (error) {
    console.error('Erro ao remover ausência do Google Calendar:', error?.response?.data || error);
    return res.status(500).json({ error: 'Erro ao remover ausência do Google Calendar' });
  }
});

/* ===== Start server ===== */
const PORT = process.env.PORT || 8085;
app.listen(PORT, () => {
  console.log(`🚀 Servidor a correr na porta ${PORT}`);
});