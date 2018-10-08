/**
 * Copyright 2018 Google Inc., PhantomJS Authors All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

'use strict';

import fs from 'fs';
import express from 'express';
import bodyParser from 'body-parser';
import firebaseAdmin from 'firebase-admin';
import fetch from 'node-fetch';
import {createTask} from './tasks.mjs';

const PORT = process.env.PORT || 8080;
const LHR = JSON.parse(fs.readFileSync('./lhr.json', 'utf8'));
const MAX_REPORTS = 10;

// Helpers
function slugify(url) {
  return url.replace(/\//g, '__');
}

function deslugify(id) {
  return id.replace(/__/g, '/');
}

function errorHandler(err, req, res, next) {
  if (res.headersSent) {
    return next(err);
  }
  console.error('errorHandler', err);
  res.status(500).send({errors: `${err}`});
}

/**
 * Audits a site using Lighthouse.
 * @param {string} url Url to audit.
 * @return {!Object} Report object saved to Firestore.
 */
async function runLighthouse(url) {
  let json = {};

  try {
    const lhr = await fetch('https://builder-dot-lighthouse-ci.appspot.com/ci', {
      method: 'POST',
      body: JSON.stringify({url, format: 'json'}),
      headers: {
        'Content-Type': 'application/json',
        'X-API-KEY': 'webdev',
      }
    }).then(resp => resp.json());

    // Trim down LH to only include category/scores.
    json = Object.values(lhr.categories).map(cat => {
      delete cat.auditRefs;
      return cat;
    });

    json = await saveReport(url, json);
  } catch (err) {
    console.error(`Error running Lighthouse: ${err}`);
  }

  return json;
}

/**
 * Saves Lighthouse report to Firestore.
 * @param {string} url URL to save run under.
 * @param {!Object} lhr Lighthouse report object.
 * @return {!Promise<!Object>}
 */
async function saveReport(url, lhr) {
  const today = new Date();
  const data = {
    lhr,
    auditedOn: today,
    lastAccessedOn: today,
  };

  await db.collection(slugify(url)).add(data);

  return data;
}

async function getAllSavedLighthouseURLs() {
  const collections = await db.getCollections();
  const urls = collections.filter(c => c.id.startsWith('http'))
    .map(c => deslugify(c.id))
    .sort();
  return urls;
}


const app = express();

app.use(function forceSSL(req, res, next) {
  const fromCron = req.get('X-Appengine-Cron');
  const fromTaskQueue = req.get('X-AppEngine-QueueName');
  if (!(fromCron || fromTaskQueue) && req.hostname !== 'localhost' &&
      req.get('X-Forwarded-Proto') === 'http') {
    return res.redirect(`https://${req.hostname}${req.url}`);
  }
  next();
});

app.use(bodyParser.raw());
app.use(bodyParser.json());
// app.use(bodyParser.text());
app.use(express.static('public'));
app.use('/node_modules', express.static('node_modules'))

app.get('/lh/categories', (req, resp) => {
  const result = Object.values(LHR.categories).map(cat => {
    return {
      title: cat.title,
      id: cat.id,
      manualDescription: cat.manualDescription
    };
  });
  resp.send(result);
});

app.get('/lh/audits', (req, resp) => {
  const result = Object.values(LHR.audits).map(audit => {
    return {
      title: audit.title,
      id: audit.id,
      description: audit.description,
    };
  });
  resp.send(result);
});

app.get('/lh/urls', async (req, resp) => {
  resp.status(200).json(await getAllSavedLighthouseURLs());
});

app.get('/lh/reports', async (req, resp, next) => {
  const url = req.query.url;
  if (!url) {
    return resp.status(400).send('No url provided.');
  }

  const querySnapshot = await db.collection(slugify(url))
      .orderBy('auditedOn', 'desc').limit(MAX_REPORTS).get();

  const runs = [];
  if (querySnapshot.empty) {
    runs.push(await runLighthouse(url));
  } else {
    querySnapshot.forEach(doc => runs.push(doc.data()));
    runs.reverse(); // Order reports from oldest -> most recent.
    // // TODO: check if there's any perf diff between this and former.
    // runs.push(...querySnapshot.docs.map(doc => doc.data()));
  }

  resp.status(200).json(runs);
});

app.post('/lh/newaudit', async (req, resp, next) => {
  let url = req.body.url || req.query.url;
  if (!url) {
    try {
      url = JSON.parse(req.body.toString('utf8'));
    } catch (err) {
      // noop
    }
  }

  // Still no URL found, bomb out.
  if (!url) {
    return resp.status(400).send('No url provided.');
  }

  const lhr = await runLighthouse(url);
  resp.status(201).json(lhr);
});

app.get('/cron/update_lighthouse_scores', async (req, resp) => {
  if (!req.get('X-Appengine-Cron')) {
    return resp.status(403).send('Sorry, handler can only be run as a GAE cron job.');
  }

  // Schedule async tasks to fetch a new LH report for each URL.
  const urls = await getAllSavedLighthouseURLs();
  for (const url of urls) {
    createTask(url).catch(err => console.error(err));
  }

  resp.status(200).send('Update tasks scheduled');
});


app.use(errorHandler);

firebaseAdmin.initializeApp({
  // credential: firebaseAdmin.credential.applicationDefault(),
  credential: firebaseAdmin.credential.cert(
      JSON.parse(fs.readFileSync('./serviceAccount.json'))),
});

const db = firebaseAdmin.firestore();
db.settings({timestampsInSnapshots: true});

// const Firestore = require('@google-cloud/firestore');

// const firestore = new Firestore({
//   projectId: 'YOUR_PROJECT_ID',
//   keyFilename: '/path/to/keyfile.json',
// });

app.listen(PORT, () => {
  console.log(`App listening on port ${PORT}`); /* eslint-disable-line */
  console.log('Press Ctrl+C to quit.'); /* eslint-disable-line */
});

