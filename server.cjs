const express = require('express');
const cors = require('cors');
const { google } = require('googleapis');
const { DateTime } = require('luxon');

const app = express();
app.use(cors());
app.use(express.json());

require("dotenv").config();

const credentials = {
  type: process.env.GOOGLE_TYPE,
  project_id: process.env.GOOGLE_PROJECT_ID,
  private_key_id: process.env.GOOGLE_PRIVATE_KEY_ID,
  private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  client_email: process.env.GOOGLE_CLIENT_EMAIL,
  client_id: process.env.GOOGLE_CLIENT_ID,
  auth_uri: process.env.GOOGLE_AUTH_URI,
  token_uri: process.env.GOOGLE_TOKEN_URI,
  auth_provider_x509_cert_url: process.env.GOOGLE_AUTH_PROVIDER_CERT_URL,
  client_x509_cert_url: process.env.GOOGLE_CLIENT_CERT_URL,
  universe_domain: process.env.GOOGLE_UNIVERSE_DOMAIN,
};

// 🔐 Autenticação
const auth = new google.auth.GoogleAuth({
  credentials: credentials,
  scopes: ['https://www.googleapis.com/auth/calendar'],
});

const calendar = google.calendar({ version: 'v3', auth });

// 📅 Rota para criar evento
app.post('/adicionar-evento', async (req, res) => {
  const { nome, servico, barbeiro, data, hora, summary, description, start, end } = req.body;

  let evento = {};

  if (summary && description && start && end) {
    // Formato estruturado (manual / recorrente)
    evento = {
      summary,
      description,
      start,
      end,
    };
  } else if (nome && servico && barbeiro && data && hora) {
    // Formato simples (cliente normal)
    const startTime = DateTime.fromISO(`${data}T${hora}`, { zone: 'Europe/Lisbon' });
    const endTime = startTime.plus({ minutes: 60 });

    evento = {
      summary: `${nome} - ${servico}`,
      description: `Barbeiro: ${barbeiro}`,
      colorId: barbeiro === 'Cláudio' ? '1' : barbeiro === 'CC' ? '2' : undefined,
      start: {
        dateTime: startTime.toISO(),
        timeZone: 'Europe/Lisbon',
      },
      end: {
        dateTime: endTime.toISO(),
        timeZone: 'Europe/Lisbon',
      },
    };
  } else {
    return res.status(400).json({ error: 'Dados em falta para criar o evento.' });
  }

  try {
    const response = await calendar.events.insert({
      calendarId: 'mhmstudio.calendar@gmail.com',
      requestBody: evento,
    });

    const iddamarcacao = response.data.id; // CORREÇÃO: declarar variável
    console.log('✅ Evento enviado para o Google Calendar:', iddamarcacao);

    return res.status(200).json({
      success: true,
      eventLink: response.data.htmlLink,
      iddamarcacao: iddamarcacao
    });
  } catch (error) {
    console.error('❌ Erro ao criar evento:', error);
    return res.status(500).json({ error: 'Erro ao criar evento no Google Calendar' });
  }
});


// 🗑 Rota para remover evento
app.post("/remover-evento", async (req, res) => {
  try {
    const { iddamarcacao } = req.body;

    if (!iddamarcacao) {
      return res.status(400).json({ error: "Falta o id do evento Google Calendar" });
    }

    await calendar.events.delete({
      calendarId: 'mhmstudio.calendar@gmail.com',
      eventId: iddamarcacao,
    });

    return res.json({ success: true });
  } catch (error) {
    console.error("Erro ao remover evento do Google Calendar:", error);
    return res.status(500).json({ error: "Erro ao remover evento do Google Calendar" });
  }
});

// 🆕 SUBSTITUI este bloco inteiro do /adicionar-ausencia
app.post("/adicionar-ausencia", async (req, res) => {
  try {
    const { nome, dataInicio, dataFim, hora } = req.body;

    if (!nome || !dataInicio) {
      return res.status(400).json({ error: "Dados insuficientes" });
    }

    const tz = "Europe/Lisbon";
    let evento;

    if (hora) {
      // Ausência numa hora específica (+1h)
      const [h, m] = hora.split(":").map(Number);
      const endH = h + 1;
      const endTime = `${String(endH).padStart(2, "0")}:${String(m).padStart(2, "0")}`;

      evento = {
        summary: `Ausência - ${nome}`,
        description: `Ausência do barbeiro ${nome}`,
        start: {
          dateTime: `${dataInicio}T${hora}:00`,
          timeZone: tz,
        },
        end: {
          dateTime: `${dataInicio}T${endTime}:00`,
          timeZone: tz,
        },
        colorId: "11", // vermelho
      };
    } else {
      // All-day → end.date = (dataFim || dataInicio) + 1 dia
      const startDate = new Date(`${dataInicio}T00:00:00`);
      const endDateBase = new Date(`${(dataFim || dataInicio)}T00:00:00`);
      const endDate = new Date(endDateBase.getTime() + 24 * 60 * 60 * 1000);

      const toISODate = (d) => d.toISOString().slice(0, 10);

      evento = {
        summary: `Ausência - ${nome}`,
        description: `Ausência do barbeiro ${nome}`,
        start: { date: toISODate(startDate) },
        end:   { date: toISODate(endDate) },
        colorId: "11",
      };
    }

    const response = await calendar.events.insert({
      calendarId: 'mhmstudio.calendar@gmail.com',
      requestBody: evento, // manter consistente com /adicionar-evento
    });

    const idAusencia = response.data.id; // 👈 igual ao das marcações
    console.log("✅ Ausência enviada para o Google Calendar:", idAusencia);

    return res.status(200).json({
      success: true,
      eventLink: response.data.htmlLink,
      idAusencia: idAusencia
    });
  } catch (error) {
    console.error("❌ Erro ao adicionar ausência:", error);
    return res.status(500).json({ error: "Erro ao adicionar ausência ao Google Calendar" });
  }
});



// 🗑 Rota para remover ausencia
app.post("/remover-ausencia", async (req, res) => {
  try {
    const { idAusencia } = req.body;

    if (!idAusencia) {
      return res.status(400).json({ error: "Falta o id do ausencia Google Calendar" });
    }

    await calendar.events.delete({
      calendarId: 'mhmstudio.calendar@gmail.com',
      eventId: idAusencia,
    });

    return res.json({ success: true });
  } catch (error) {
    console.error("Erro ao remover ausencia do Google Calendar:", error);
    return res.status(500).json({ error: "Erro ao remover ausencia do Google Calendar" });
  }
});


app.listen(8085);
