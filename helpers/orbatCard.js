'use strict';

function esc(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function createCardBuilder(rolesBySquad, teamsBySquad) {
    return function buildSquadCard(squad, opts) {
        const { canEdit, canDynamic, canDeleteSquad, badgeHtml, renderRole } = opts;
        const roles = rolesBySquad[squad.id] || [];
        const teams = teamsBySquad[squad.id] || [];

        const lrBadge = squad.lr_frequency ? `<span title="Long Range" style="font-size:0.68em;background:rgba(0,100,200,0.25);color:#7bb3e0;padding:1px 5px;border-radius:3px;white-space:nowrap;">LR ${esc(squad.lr_frequency)}</span>` : '';
        const srBadge = squad.sr_frequency ? `<span title="Short Range" style="font-size:0.68em;background:rgba(0,180,100,0.25);color:#7de0a5;padding:1px 5px;border-radius:3px;white-space:nowrap;">SR ${esc(squad.sr_frequency)}</span>` : '';

        const squadEditForm = canEdit ? `
        <div id="editSquadForm_${squad.id}" style="display:none;margin-bottom:8px;padding:8px;background:rgba(0,0,0,0.2);border-radius:4px;">
            <input type="text" id="editSquadName_${squad.id}" value="${esc(squad.name)}"
                   style="width:100%;box-sizing:border-box;margin:0 0 6px 0;font-size:0.88em;padding:5px 8px;">
            <div style="display:flex;gap:6px;align-items:center;justify-content:flex-end;">
                <input type="color" id="editSquadColor_${squad.id}" value="${esc(squad.color)}" style="width:34px;height:30px;flex-shrink:0;border:none;background:none;cursor:pointer;padding:0;">
                <button onclick="submitEditSquad(${squad.id})" class="btn btn-primary" style="flex-shrink:0;padding:4px 10px;font-size:0.85em;">Save</button>
                <button onclick="document.getElementById('editSquadForm_${squad.id}').style.display='none'" class="btn" style="flex-shrink:0;padding:4px 8px;font-size:0.85em;">✕</button>
            </div>
        </div>` : '';

        const squadFreqForm = canEdit ? `
        <div id="sqFreqForm_${squad.id}" style="display:none;padding:6px 8px;background:rgba(0,0,0,0.25);border-radius:4px;margin-bottom:6px;">
            <div style="display:flex;gap:4px;align-items:center;flex-wrap:wrap;">
                <span style="font-size:0.75em;color:var(--khaki);white-space:nowrap;">LR</span>
                <input type="text" id="sqLrFreq_${squad.id}" value="${esc(squad.lr_frequency || '')}" placeholder="e.g. 45.300" style="width:80px;flex-shrink:0;margin:0;font-size:0.8em;padding:3px 6px;">
                <span style="font-size:0.75em;color:var(--khaki);white-space:nowrap;">SR</span>
                <input type="text" id="sqSrFreq_${squad.id}" value="${esc(squad.sr_frequency || '')}" placeholder="e.g. 50.100" style="width:80px;flex-shrink:0;margin:0;font-size:0.8em;padding:3px 6px;">
                <button onclick="submitSquadFrequencies(${squad.id})" class="btn btn-primary" style="padding:2px 8px;font-size:0.78em;flex-shrink:0;">Save</button>
                <button onclick="document.getElementById('sqFreqForm_${squad.id}').style.display='none'" class="btn" style="padding:2px 6px;font-size:0.78em;flex-shrink:0;">✕</button>
            </div>
        </div>` : '';

        const unassigned = roles.filter(r => !r.team_id);
        let unassignedHtml;
        if (roles.length === 0 && teams.length === 0) {
            unassignedHtml = `<div id="unassigned-${squad.id}" data-team-roles="${squad.id}" data-team-id="" style="min-height:6px;"><p style="color:var(--khaki);opacity:0.7;font-size:0.9em;font-style:italic;">No roles defined</p></div>`;
        } else {
            unassignedHtml = `<div id="unassigned-${squad.id}" data-team-roles="${squad.id}" data-team-id="" style="min-height:6px;">
            ${teams.length > 0 && unassigned.length > 0 ? `<div style="padding:2px 8px 0;font-size:0.63em;color:var(--khaki);opacity:0.5;text-transform:uppercase;letter-spacing:0.06em;">Ungrouped</div>` : ''}
            ${unassigned.map(r => renderRole(r)).join('')}
        </div>`;
        }

        const teamsHtml = teams.map(team => {
            const teamRoles = roles.filter(r => r.team_id === team.id);
            const teamCtrlMenu = canEdit ? `
            <div class="ctrl-menu">
                <button class="ctrl-menu-btn" onclick="toggleCtrlMenu(this)">···</button>
                <div class="ctrl-menu-list">
                    <button class="ctrl-menu-item" onclick="toggleFreqForm('tm', ${team.id})">Radio Freq</button>
                    <button class="ctrl-menu-item" onclick="startEditTeam(${team.id})">Rename</button>
                    ${canDynamic ? `<button class="ctrl-menu-item ctrl-menu-danger" onclick="deleteTeam(${team.id})">Delete team</button>` : ''}
                </div>
            </div>` : '';
            const teamEditForm = canEdit ? `
            <div id="editTeamForm_${team.id}" style="display:none;padding:4px 8px;background:rgba(0,0,0,0.25);">
                <div style="display:flex;gap:4px;align-items:center;">
                    <input type="text" id="editTeamName_${team.id}" value="${esc(team.name)}" style="flex:1;margin:0;font-size:0.82em;padding:3px 6px;">
                    <input type="color" id="editTeamColor_${team.id}" value="${esc(team.color)}" style="width:28px;height:28px;flex-shrink:0;border:none;background:none;cursor:pointer;padding:0;">
                    <button onclick="submitEditTeam(${team.id})" class="btn btn-primary" style="flex-shrink:0;padding:2px 8px;font-size:0.78em;">Save</button>
                    <button onclick="document.getElementById('editTeamForm_${team.id}').style.display='none'" class="btn" style="flex-shrink:0;padding:2px 6px;font-size:0.78em;">✕</button>
                </div>
            </div>` : '';
            const teamLrBadge = team.lr_frequency ? `<span title="Long Range" style="font-size:0.65em;background:rgba(0,100,200,0.25);color:#7bb3e0;padding:1px 4px;border-radius:3px;white-space:nowrap;">LR ${esc(team.lr_frequency)}</span>` : '';
            const teamSrBadge = team.sr_frequency ? `<span title="Short Range" style="font-size:0.65em;background:rgba(0,180,100,0.25);color:#7de0a5;padding:1px 4px;border-radius:3px;white-space:nowrap;">SR ${esc(team.sr_frequency)}</span>` : '';
            const teamFreqBadges = (teamLrBadge || teamSrBadge) ? `<div style="display:flex;gap:2px;flex-wrap:wrap;margin-top:2px;">${teamLrBadge}${teamSrBadge}</div>` : '';
            const teamFreqForm = canEdit ? `
            <div id="tmFreqForm_${team.id}" style="display:none;padding:4px 8px;background:rgba(0,0,0,0.25);">
                <div style="display:flex;gap:4px;align-items:center;flex-wrap:wrap;">
                    <span style="font-size:0.75em;color:var(--khaki);white-space:nowrap;">LR</span>
                    <input type="text" id="tmLrFreq_${team.id}" value="${esc(team.lr_frequency || '')}" placeholder="e.g. 45.300" style="width:80px;flex-shrink:0;margin:0;font-size:0.8em;padding:3px 6px;">
                    <span style="font-size:0.75em;color:var(--khaki);white-space:nowrap;">SR</span>
                    <input type="text" id="tmSrFreq_${team.id}" value="${esc(team.sr_frequency || '')}" placeholder="e.g. 50.100" style="width:80px;flex-shrink:0;margin:0;font-size:0.8em;padding:3px 6px;">
                    <button onclick="submitTeamFrequencies(${team.id})" class="btn btn-primary" style="padding:2px 8px;font-size:0.78em;flex-shrink:0;">Save</button>
                    <button onclick="document.getElementById('tmFreqForm_${team.id}').style.display='none'" class="btn" style="padding:2px 6px;font-size:0.78em;flex-shrink:0;">✕</button>
                </div>
            </div>` : '';
            return `<div data-team-block="${team.id}">
            <div class="team-hdr" style="${canEdit ? 'cursor:grab;' : ''}display:flex;align-items:center;gap:4px;padding:3px 8px;margin-top:4px;background:rgba(0,0,0,0.25);border-left:3px solid ${team.color};">
                <div style="flex:1;min-width:0;overflow:hidden;">
                    <div style="font-size:0.7em;font-weight:700;color:${team.color};letter-spacing:0.04em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(team.name)}</div>
                    ${teamFreqBadges}
                </div>
                ${teamCtrlMenu}
            </div>
            ${teamEditForm}
            ${teamFreqForm}
            <div id="team-roles-${team.id}" data-team-roles="${squad.id}" data-team-id="${team.id}" style="min-height:10px;">
                ${teamRoles.map(r => renderRole(r)).join('')}
            </div>
        </div>`;
        }).join('');

        const addTeamHtml = canDynamic
            ? `<div id="addTeamForm_${squad.id}" style="display:none;margin-top:6px;padding:6px 8px;background:rgba(0,0,0,0.2);border-radius:4px;border:1px dashed ${squad.color};">
            <div style="display:flex;gap:4px;align-items:center;">
                <input type="text" id="addTeamName_${squad.id}" placeholder="Team name..." style="flex:1;min-width:0;margin:0;font-size:0.82em;padding:4px 6px;">
                <input type="color" id="addTeamColor_${squad.id}" value="${squad.color}" style="width:28px;height:28px;flex-shrink:0;border:none;background:none;cursor:pointer;padding:0;">
                <button onclick="submitAddTeam(${squad.id})" class="btn btn-primary" style="flex-shrink:0;height:28px;padding:0 8px;font-size:0.8em;">➕</button>
                <button onclick="document.getElementById('addTeamForm_${squad.id}').style.display='none'" class="btn" style="flex-shrink:0;height:28px;padding:0 6px;font-size:0.8em;">✕</button>
            </div>
           </div>
           <button onclick="toggleAddTeam(${squad.id})" class="btn" style="margin-top:5px;width:100%;background:rgba(0,0,0,0.15);border:1px dashed rgba(178,178,125,0.3);font-size:0.75em;padding:3px;">➕ Add Team</button>`
            : '';

        const addRoleSection = canDynamic ? `
        <div style="margin-top:8px;padding:8px;border:2px dashed ${squad.color};border-radius:4px;background:rgba(0,0,0,0.2);overflow:hidden;">
            <div style="display:flex;gap:6px;align-items:center;min-width:0;">
                <input type="text" id="newRoleName_${squad.id}" placeholder="New slot name..."
                       style="flex:1;min-width:0;padding:6px 8px;background:rgba(40,40,40,0.9);color:var(--sand);border:1px solid var(--olive);border-radius:4px;font-size:0.88em;margin:0;"
                       onkeydown="if(event.key==='Enter') addRole(${squad.id})">
                <button onclick="addRole(${squad.id})" class="btn" style="flex-shrink:0;padding:6px 10px;background:${squad.color};color:white;font-size:0.85em;">➕</button>
            </div>
        </div>` : '';

        const addSubgroupSection = canDynamic ? `
        <div id="addSubForm_${squad.id}" style="display:none;margin-top:10px;padding:10px;border:1px dashed var(--khaki);border-radius:4px;background:rgba(0,0,0,0.2);overflow:hidden;">
            <div style="display:flex;gap:6px;align-items:center;min-width:0;">
                <input type="text" id="addSubName_${squad.id}" placeholder="Sub-group name..." style="flex:1;min-width:0;padding:6px 8px;background:rgba(40,40,40,0.9);color:var(--sand);border:1px solid var(--olive);border-radius:4px;font-size:0.88em;margin:0;" onkeydown="if(event.key==='Enter'){event.preventDefault();submitAddChildSquad(${squad.id})}">
                <input type="color" id="addSubColor_${squad.id}" value="#6b8e23" style="width:34px;height:34px;flex-shrink:0;border:none;background:none;cursor:pointer;padding:0;">
                <button onclick="submitAddChildSquad(${squad.id})" class="btn btn-primary" style="flex-shrink:0;height:34px;padding:0 10px;font-size:0.85em;">➕</button>
                <button onclick="document.getElementById('addSubForm_${squad.id}').style.display='none'" class="btn" style="flex-shrink:0;height:34px;padding:0 8px;font-size:0.85em;">✕</button>
            </div>
        </div>
        <button onclick="toggleAddSub(${squad.id})" class="btn" style="margin-top:8px;width:100%;background:rgba(0,0,0,0.2);border:1px dashed var(--khaki);font-size:0.8em;padding:6px;">➕ Add Sub-group</button>` : '';

        const fileInput = canEdit ? `<input type="file" id="iconInput_${squad.id}" accept="image/*" style="display:none" onchange="uploadSquadIcon(${squad.id}, this)">` : '';
        const iconImg = squad.icon ? `<img src="/uploads/squad-icons/${esc(squad.icon)}" style="width:28px;height:28px;border-radius:4px;object-fit:cover;border:1px solid ${squad.color};flex-shrink:0;">` : '';
        const ctrlMenu = canEdit ? `
        <div class="ctrl-menu">
            <button class="ctrl-menu-btn" onclick="toggleCtrlMenu(this)">···</button>
            <div class="ctrl-menu-list">
                <button class="ctrl-menu-item" onclick="document.getElementById('iconInput_${squad.id}').click()">${squad.icon ? 'Change icon' : 'Upload icon'}</button>
                ${squad.icon ? `<button class="ctrl-menu-item ctrl-menu-danger" onclick="removeSquadIcon(${squad.id})">Remove icon</button>` : ''}
                <button class="ctrl-menu-item" onclick="toggleFreqForm('sq', ${squad.id})">Radio Freq</button>
                <button class="ctrl-menu-item" onclick="startEditSquad(${squad.id})">Edit group</button>
                ${canDeleteSquad ? `<button class="ctrl-menu-item ctrl-menu-danger" onclick="deleteSquad(${squad.id})">Delete group</button>` : ''}
            </div>
        </div>` : '';

        return `<div class="card orbat-squad-card" style="border-left:4px solid ${squad.color};padding:10px 12px;">
        ${fileInput}
        <div style="margin-bottom:6px;padding-bottom:6px;border-bottom:2px solid ${squad.color};display:flex;align-items:center;justify-content:space-between;gap:6px;">
            <div style="display:flex;align-items:center;gap:7px;flex:1;min-width:0;">
                ${canEdit ? '<span class="squad-drag-handle" title="Drag to reorder" style="cursor:grab;color:var(--khaki);opacity:0.35;flex-shrink:0;font-size:1.05em;user-select:none;padding:0 2px;">⠿</span>' : ''}
                ${iconImg}
                <div style="min-width:0;">
                    <div style="display:flex;align-items:center;gap:4px;flex-wrap:wrap;">
                        <h3 style="color:${squad.color};margin:0;font-size:0.92em;word-break:break-word;">${esc(squad.name)}</h3>
                        ${badgeHtml || ''}
                        ${lrBadge}${srBadge}
                    </div>
                </div>
            </div>
            ${ctrlMenu}
        </div>
        ${squadEditForm}
        ${squadFreqForm}
        ${unassignedHtml}
        <div id="teams-order-${squad.id}">${teamsHtml}</div>
        ${addTeamHtml}
        ${addRoleSection}
        ${addSubgroupSection}
    </div>`;
    };
}

module.exports = { createCardBuilder };
