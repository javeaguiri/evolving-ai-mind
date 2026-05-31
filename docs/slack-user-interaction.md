Interactivity
HANDLING USER INTERACTION IN YOUR SLACK APPS
On this page
Handling user
interaction in your
Slack apps
User interactions can blossom forth from the
seeds planted in Slack apps. Cultivate the healthy
growth of these interactions by preparing your
app to understand and respond to them.
This guide will explain the nuances of user-
triggered interactions and the steps necessary to
handle the contextual interaction information
your app will receive.
The flow of user-triggered
interactions
We explained in invocation & interactivity that
interactions are essentially a trigger and a
response. Apps can implement a number of
interaction entry points that allow users to
intentionally invoke a response from the app.
Read our overview of those entry points to dig
deeper into the field of options.
When one of those entry points is triggered, a
new aspect is introduced to the interaction
transaction — the interaction payload. This
payload is a bundle of information that explains
the context of the user action, giving the app
enough information to construct a coherent
response. We end up with an interaction flow
that looks like this:
A user triggers an interaction by engaging
with one of your app's entry points.
Your app receives and processes the
interaction payload.
Using this context, your app generates a
response to the interaction.
Your app needs to be ready for the last two
steps.
Preparing your app for user
interactions
In order for your app to receive interaction
payloads, Slack needs to know where to send
them. Each app can be configured with Request
URLs that indicate a web endpoint belonging to
the app.
To configure a Request URL for your app:
Open the App Management dashboard.
Select Interactivity & Shortcuts.
Toggle Interactivity on.
You'll see a few new options appear. The ones
relevant to us are:
Request URL: the URL we'll send the request
payload to when interactive components or
shortcuts are used. You'll need to set up a
URL to handle these payloads, as we'll
describe below. Save your changes after
you've added one.
If you are distributing your app, this
request URL needs to be an HTTPS URL
(self-signed certificates are not allowed). If
you're just building a single-workspace
app, it can be plain HTTP.
This Request URL is also used by modals
for view_submission event payloads.
Your app can distinguish between the
diﬀerent types of payload using the type
field as explained below.
Options Load URL: this is a setting used by
some Block Kit interactive components, i.e.
select menus and multi-select menus. These
components can load menu options from an
external source, and Options Load URL
determines which URL is queried to return
those menu options.
You can leave Options Load URL blank for
now. We recommend reading the
reference guide for this component.
If you create Slash Commands for your
app, you'll find that each command has its
own Request URL. Read our guide to
creating Slash Commands to learn more.
You're all set! Your app can start receiving
payloads. Now let's see how to process them.
Handling interaction
payloads
We mentioned that there were a few diﬀerent
types of interaction payloads your app might
receive. They'll be sent to your specified Request
URL in an HTTP POST request in the form
application/x-www-form-urlencoded. For
more information, refer to Using the Slack Web
API: Basics. The body of the request will contain
a payload parameter; your app should parse
this payload parameter as JSON.
The resulting object can have diﬀerent structures
depending on the source. All those structures
will have a type field that indicates the source of
the interaction. Our reference docs have a more
detailed look at the payload structures for the
diﬀerent type sources:
block_actions payloads are received when a
user clicks a Block Kit interactive component.
shortcut and message_actions payloads
are received when global and message
shortcuts are used.
view_submission payloads are received
when a modal is submitted.
view_closed payloads are received when a
modal is canceled.
In each case, the fields within the payload will
provide a full context of the interaction. This will
include the interacting user, the pre-defined
state fields of any interactive component used,
where the interaction happens, and more. Use
this structure and these fields to interpret the
request. You can use as much or as little of the
info as your app needs. The payload types that
your app can receive will depend on the other
features your app implements. For example, if
your app never publishes any interactive
components, it will never receive a
block_actions payload.
Read our interaction payload reference docs to
examine the detailed structure for the features
your app uses, and design the app to be able to
process those fields.
Now that your app can receive and process
interaction payloads, it needs to know what to
do after one is sent.
Responding to users
There are a bouquet of potential responses to
the receipt of an interaction payload:
Acknowledgment response: a required,
immediate response that confirms your app
received the payload.
Message responses: optional responses that
use a special URL from the payload to publish
messages.
Modal responses: optional responses that
use a short-lived code from the payload to
invoke a modal.
Asynchronous responses: optional responses
that are inspired by the info in the payload,
but not directly related.
Acknowledgment response
All apps must, as a minimum, acknowledge the
receipt of a valid interaction payload.
To do that, your app must reply to the HTTP
POST request with an HTTP 200 OK response.
This must be sent within 3 seconds of receiving
the payload. If your app doesn't do that, the
Slack user who interacted with the app will see
an error message, so ensure your app responds
quickly. Otherwise, the user won't see anything
when your app only sends an acknowledgment
response. If you want to do more, keep reading.
Message responses
Depending on the source, the interaction
payload your app receives may contain a
response_url. This response_url is unique to
each payload, and can be used to publish
messages back to where the interaction
happened.
If you don't receive a response_url
in your interaction payload you can use a
trigger_id and a modal to get one for
your app.
For example, the payload from a global
shortcut will not contain one.
These responses can be sent up to 5 times
within 30 minutes of receiving the payload.
Even when sending composed responses,
you must still send an acknowledgment
response.
Read more.
For GovSlack devs
If you're developing a GovSlack app for use
by public sector customers, point your
response_url to the slack-gov.com
domain instead of the slack.com domain.
Within these responses, you can include a
message payload. This message payload can be
composed according to the same message
composition guides as any other. You can use a
response_url by making an HTTP POST directly
to the URL and including a message payload in
the HTTP body.
The response_url
The response_url will bypass any channel
posting permissions when used as a part of
an app's action, since it is opening up a
return pathway from the originating action
(e.g. slash command, button click, and so
on) in order to react to the user's interaction
with the app.
If your app needs more than 30 minutes to
respond with a message, you'll need to publish it
in the standard way.
Go here for more details about how to
handle a response_URL in JavaScript, or here for
more details about how to do this in Python.
Below are examples for diﬀerent types of
message responses.
Publishing ephemeral responses
By default, a message published via
response_url will be sent as an ephemeral
message:
POST https://hooks.slack.com/services/T00000000/B00000000/XXXXXXXXXX
Content-type: application/json
{
"text": "Oh hey, this is a nifty ephemeral message response!"
}
Publishing responses in channel
If you want to publish a message to the same
conversation as the interaction source, include
an attribute response_type and set its value to
in_channel.
POST https://hooks.slack.com/services/T00000000/B00000000/XXXXXXXXXX
Content-type: application/json
{
"text": "Oh hey, this is a fun message in a channel!",
"response_type": "in_channel"
}
Publishing responses in thread
If you want to publish a message to a specific
thread, you'll need to include an attribute
response_type and set its value to in_channel.
Then, to specify the thread, include a
thread_ts.
Also, be sure to set replace_original to false
or you'll overwrite the message you're wanting to
respond to!
POST https://hooks.slack.com/services/T00000000/B00000000/XXXXXXXXXX
Content-type: application/json
{
"text": "Oh hey, this is a marvelous message in a thread!",
"response_type": "in_channel",
"replace_original": "false",
"thread_ts": "1234567890"
}
Updating a source message in response
If your app received an interaction payload after
an interactive component was used inside of a
message, you can use response_url to update
that source message.
Include an attribute replace_original and set
it to true:
POST https://hooks.slack.com/services/T00000000/B00000000/XXXXXXXXXX
Content-type: application/json
{
"replace_original": "true",
"text": "Thanks for your request, we'll process it and get back
}
Feel free to include blocks in your response_url
update.
Non-ephemeral messages can also be updated
using chat.update. A message's type cannot be
changed from ephemeral to in_channel. Once
a message is issued, it retains its visibility quality
for life.
You cannot use replace_original to modify
the user-posted message that invokes a slash
command.
Deleting a source message in response
You can also delete a source message of an
interaction entirely using response_url.
Include delete_original as the sole attribute
in your response_url JSON, with the value set
to true:
POST https://hooks.slack.com/services/T00000000/B00000000/XXXXXXXXXX
Content-type: application/json
{
"delete_original": "true"
}
Non-ephemeral messages can also be deleted
using chat.delete.
If you include a new message payload and
delete_original, the source message will be
deleted, and your new message published.
The delete_original field is not supported for
use with slash commands, so sending it will not
remove or retain a user-posted message that is
invoked by the slash command.
Modal responses
The wonderful thing about triggers is that
trigger_ids are wonderful things. They're
attached to events and interactions. They
expire in three seconds. They're fun fun fun
fun fun! But the most wonderful thing about
triggers is they can be used only once.
When certain events and interactions occur
between users and your app, you'll receive a
trigger_id as part of the interaction payload. If
you have a trigger_id, you can use the value of
that field to open a modal.
Triggers expire in three seconds. Use them
before you lose them. You'll receive a
trigger_expired error when using a method
with an expired trigger_id.
Triggers may only be used once. You may
perform just one operation with a trigger_id.
Subsequent attempts are presented with a
trigger_exchanged error.
Using a modal to generate a response_url
When you're composing your modal, you can
use special parameters to generate a
response_url when the modal is submitted.
Read our guide to using modals to learn more
about this technique. You can then use this
newly-generated response_url to publish a
message as described above.
Asynchronous responses
The receipt of an interaction payload may furnish
your app with a response_url or a trigger_id,
but it also imbues a lot of contextual knowledge
about the interaction.
That context can be used by your app to do, well,
anything. For example, it can:
respond to a user clicking a Complete Task
button in an interactive message by a adding
a happy reaction emoji to the source
message.
use a modal submission as the trigger for an
update of the app's Home tab.
send data to query and update an external
service after the use of an app action.
order cheeseburgers (hold the onions) for the
team after someone clicks the Bring me
Lunch button.
Growing your garden
We're excited about the possibilities opened to
your app, when your apps are open to possible
interactions.
Get some inspiration by reading our guide to
planning your app, and enable more
opportunities for interaction by using the
available app surfaces.
TOOLS
Slack CLI
Bolt frameworks
Slack SDKs
Block Kit Builder
Developer program
Code samples & tutorials
All tools
LEARN
Learning paths
Workshops
Slack certifications
Trailhead
Resource library
All learning resources
COMMUNITY
Slack community
Slack events
RESOURCES
Docs
Blog
Slack marketplace
Developer newsletter
MANAGE APPS
Your apps
Status Privacy Terms Cookie
Support Changelog Preferences
Your
Privacy
Choices
© 2026 Slack Technologies, LLC, a Salesforce company. All rights reserved.
Various trademarks held by their respective owners.