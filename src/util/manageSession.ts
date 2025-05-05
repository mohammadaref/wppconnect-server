/*
 * Copyright 2023 WPPConnect Team
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

import archiver from 'archiver';
import { Request } from 'express';
import fileSystem from 'fs';
import path from 'path';
import unzipper from 'unzipper';

import { logger } from '..';
import config from '../config';
import { startAllSessions } from './functions';
import getAllTokens from './getAllTokens';
import { clientsArray } from './sessionUtil';

export function backupSessions(req: Request): Promise<any> {
  // eslint-disable-next-line no-async-promise-executor
  return new Promise(async (resolve, reject) => {
    await closeAllSessions(req);
    const output = fileSystem.createWriteStream(
      __dirname + '/../backupSessions.zip'
    );
    const archive = archiver('zip', {
      zlib: { level: 9 }, // Sets the compression level.
    });
    archive.on('error', function (err) {
      reject(err);
      req.logger.error(err);
    });
    archive.pipe(output);
    archive.directory(__dirname + '/../../tokens', 'tokens');
    fileSystem.cpSync(
      config.customUserDataDir,
      __dirname + '/../../backupFolder',
      { force: true, recursive: true }
    );

    archive.directory(__dirname + '/../../backupFolder', 'userDataDir');
    archive.finalize();

    output.on('close', () => {
      fileSystem.rmSync(__dirname + '/../../backupFolder', { recursive: true });
      const myStream = fileSystem.createReadStream(
        __dirname + '/../backupSessions.zip'
      );
      myStream.pipe(req.res as any);
      myStream.on('end', () => {
        logger.info('Sessions successfully backuped. Restarting sessions...');
        startAllSessions(config, logger);
        req.res?.end();
      });
      myStream.on('error', function (err: any) {
        console.log(err);
        reject(err);
      });
    });
  });
}

export async function restoreSessions(
  req: Request,
  file: Express.Multer.File
): Promise<any> {
  if (!file?.mimetype?.includes('zip')) {
    throw new Error('Please, send zipped file');
  }
  const path = file.path;
  logger.info('Starting restore sessions...');
  await closeAllSessions(req);

  const extract = fileSystem
    .createReadStream(path)
    .pipe(unzipper.Extract({ path: './restore' }));
  extract.on('close', () => {
    try {
      fileSystem.cpSync(__dirname + '/../../restore/tokens', 'tokens', {
        force: true,
        recursive: true,
      });
    } catch (error) {
      logger.info("Folder 'tokens' not found.");
    }
    try {
      fileSystem.cpSync(
        __dirname + '/../../restore/userDataDir',
        config.customUserDataDir,
        {
          force: false,
          recursive: true,
        }
      );
    } catch (error) {
      logger.info("Folder 'userDataDir' not found.");
    }
    logger.info('Sessions successfully restored. Starting...');
    startAllSessions(config, logger);
  });

  return { success: true };
}

export async function closeAllSessions(req: Request) {
  const names = await getAllTokens(req);
  names.forEach(async (session: string) => {
    const client = clientsArray[session];
    try {
      delete clientsArray[session];
      if (client?.status) {
        logger.info('Stopping session: ' + session);
        await client.page.browser().close();
      }
      delete clientsArray[session];
    } catch (error) {
      logger.error('Error stopping session: ' + session, error);
    }
  });
  await new Promise((resolve) => setTimeout(resolve, 500));
}

export async function deleteAllSessions(req: Request) {
  logger.info('Attempting to delete all sessions...');
  await closeAllSessions(req);
  logger.info('All active browser sessions closed.');

  const sessionDirPath = path.resolve(config.customUserDataDir);
  logger.info(`Attempting to clear session directory: ${sessionDirPath}`);

  // --- Clear UserDataDir ---
  try {
    if (fileSystem.existsSync(sessionDirPath)) {
      const items = fileSystem.readdirSync(sessionDirPath);
      for (const item of items) {
        const itemPath = path.join(sessionDirPath, item);
        try {
          if (fileSystem.lstatSync(itemPath).isDirectory()) {
            fileSystem.rmSync(itemPath, { recursive: true, force: true });
            logger.info(`Deleted directory: ${itemPath}`);
          } else {
            fileSystem.unlinkSync(itemPath);
            logger.info(`Deleted file: ${itemPath}`);
          }
        } catch (itemErr: any) {
          logger.error(
            `Error deleting item ${itemPath}: ${itemErr.message || itemErr}`
          );
        }
      }
      logger.info(`Successfully cleared session directory: ${sessionDirPath}`);
    } else {
      logger.warn(
        `Session directory does not exist, nothing to clear: ${sessionDirPath}`
      );
    }
  } catch (err: any) {
    logger.error(
      `Error clearing session directory ${sessionDirPath}: ${
        err.message || err
      }`
    );
    // Decide if we should stop or continue to token deletion
    // For now, log the error and continue to token deletion
  }

  // --- Clear Tokens Directory ---
  const tokensDirPath = path.resolve(__dirname, '../../tokens'); // Path to tokens dir from src/util
  logger.info(`Attempting to clear tokens directory: ${tokensDirPath}`);

  try {
    if (fileSystem.existsSync(tokensDirPath)) {
      const items = fileSystem.readdirSync(tokensDirPath);
      for (const item of items) {
        const itemPath = path.join(tokensDirPath, item);
        // Ensure we only delete files (like .data.json) and not unexpected subdirectories
        if (!fileSystem.lstatSync(itemPath).isDirectory()) {
          try {
            fileSystem.unlinkSync(itemPath);
            logger.info(`Deleted token file: ${itemPath}`);
          } catch (itemErr: any) {
            logger.error(
              `Error deleting token file ${itemPath}: ${
                itemErr.message || itemErr
              }`
            );
          }
        } else {
          logger.warn(
            `Skipping unexpected directory in tokens folder: ${itemPath}`
          );
        }
      }
      logger.info(`Successfully cleared tokens directory: ${tokensDirPath}`);
    } else {
      logger.warn(
        `Tokens directory does not exist, nothing to clear: ${tokensDirPath}`
      );
    }
  } catch (err: any) {
    logger.error(
      `Error clearing tokens directory ${tokensDirPath}: ${err.message || err}`
    );
    // If clearing either directory fails, we should probably report an overall failure
    throw new Error(
      `Failed to fully clear all session data. Error during token cleanup: ${
        err.message || err
      }`
    );
  }

  // --- Final Return ---
  return {
    success: true,
    message: 'All sessions closed and data/tokens cleared.',
  };
}
