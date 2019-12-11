const CommandCall = require('../structures/CommandCall');
const CooldownManager = require('./CooldownManager');
const CommandError = require('./CommandError');
const Middleware = require('./Middleware');
const MiddlewareError = require('./MiddlewareError');
const Util = require('../util/Util');
const Text = require('../util/Text');

/**
 * Runs commands in Chop.
 * @since v0.0.1
 */
class CommandRunner extends Middleware {
  /**
   * @param {ChopClient} client The client that instantiated this class.
   * @param {ChopOptions} options The configuration object.
   */
  constructor(client, options) {
    super();
    this.client = client;
    this.options = options;

    /**
     * The cooldown manager for this runner.
     * @type {CooldownManager}
     * @name CommandRunner#cooldowns
     */
    this.cooldowns = new CooldownManager(client);
  }

  /**
   * Makes the bot start listening for commands.
   * @memberof CommandRunner
   */
  listen() {
    this.client.on('message', message => {
      const content = message.content.trim().toLowerCase();
      const isPrefixed = content.replace(/\s\s+/g, ' ').startsWith(this.options.prefix);
      if (!isPrefixed || (message.author.bot && !this.options.allowBots)) return;

      const isDM = message.channel.type === 'dm';
      if (isDM && this.options.dmCommands === 'ignore') return;
      if (isDM && this.options.dmCommands === 'error') {
        this.sendMessage(message.channel, this.options.messages.directMessageError);
        return;
      }

      const call = new CommandCall(this.client, message);

      if (!call.commandExists) {
        if (this.options.showNotFoundMessage) {
          this.sendMessage(message.channel, this.options.messages.commandNotFound);
          if (call.bestMatch) {
            message.channel.send(Util.format(this.options.messages.bestMatch, call.bestMatch));
          }
        }
        return;
      }

      if (call.isDM && !call.command.runIn.includes('dm')) {
        this.sendMessage(
          message.channel,
          Util.format(this.options.messages.directMessageErrorSpecific, call.commandName),
        );
        return;
      }

      try {
        this.go(call, commandCall => {
          this.run(message, commandCall);
        });
      } catch (e) {
        const error = new MiddlewareError('An error happened in a middleware.', call);
        error.stack += `\nORIGINAL STACK:\n${e.stack}`;
        this.client.emit('error', error);
      }
    });
  }

  /**
   * Runs a command call.
   * @param {external:Message} message The discord message for this command.
   * @param {CommandCall} call
   * @memberof CommandRunner
   */
  run(message, call) {
    if (call.command.hidden && !call.isSuperUser) {
      if (this.options.showNotFoundMessage) {
        this.sendMessage(message.channel, this.options.messages.commandNotFound);
        if (this.options.findBestMatch) {
          this.sendMessage(message.channel, Util.format(this.options.messages.bestMatch, call.bestMatch));
        }
      }
      return;
    }

    if (call.command.admin && !call.isAdmin) {
      this.sendMessage(message.channel, Util.format(this.options.messages.missingPermissions, call.commandName));
      return;
    }

    if (!call.hasEnoughArgs) {
      // TODO: Implement argument prompting
      this.sendMessage(message.channel, Util.format(this.options.messages.missingArgument, call.missingArg));
      this.sendMessage(
        message.channel,
        Util.format(
          this.options.messages.usageMessage,
          this.options.prefix,
          call.command.name,
          call.command.usage || call.command.args.reduce((acc, cur) => `${acc}<${cur}> `, ''),
        ),
      );
      return;
    }

    const cooldownLeft = this.cooldowns.getTimeLeft(call.commandName, call.caller);

    if (cooldownLeft > 0) {
      this.sendMessage(
        message.channel,
        Util.format(this.options.messages.cooldown, Util.secondsToTime(cooldownLeft), call.commandName),
      );
      return;
    }

    this.cooldowns.updateTimeLeft(call.commandName, call.caller);

    const safeSend = (...args) => {
      const lines = [...args];
      const lastArg = lines.pop();
      const msg = Text.lines(...lines, typeof lastArg === 'string' ? lastArg : '');
      message.channel.send(msg, Util.isObject(lastArg) ? lastArg : undefined).catch(err => {
        err.command = call.commandName || undefined;
        err.guild = call.guild ? call.guild.name : undefined;
        this.client.emit('error', err);
      });
    };

    call.command.send = safeSend;

    if (call.command.delete) {
      message.delete({ reason: `Executed the ${call.commandName} command.` }).catch(() => {});
    }

    // Note to future self: Yes. You did this. Deal with it.
    const promiseErrorHack = (subject, args, normalErrorHandler) => {
      try {
        subject(...args).catch(normalErrorHandler);
      } catch (err) {
        if (err instanceof TypeError && /catch/.test(err.message)) {
          // This error is from the .catch() above
        } else {
          normalErrorHandler(err);
        }
      }
    };

    // haha fun
    promiseErrorHack(
      (...args) => call.command.run(...args),
      [message, call.args, call],
      err => this.client.emit('error', new CommandError(call.command, call, err)),
    );
  }

  /**
   * Tries to send a message. Emit warning if can't.
   * @param {Object} channel The channel to send the message to.
   * @param {string} content The message to be send.
   * @memberof CommandRunner
   */
  sendMessage(channel, content) {
    channel.send(content).catch(err => {
      this.client.emit('error', err);
    });
  }

  /**
   * Handles command call errors.
   * @param {CommandError} commandError The command error object.
   * @memberof CommandRunner
   */
  emitError(commandError) {
    this.client.emit('error', commandError);
  }
}

module.exports = CommandRunner;
