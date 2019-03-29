package com.codestream

import com.codestream.settings.CodeStreamConfigurableGUI
import com.intellij.openapi.options.SearchableConfigurable
import com.intellij.openapi.project.Project
import javax.swing.JComponent

class CodeStreamConfigurable(val project: Project) : SearchableConfigurable, ServiceConsumer(project) {
    private var _gui: CodeStreamConfigurableGUI? = null

    override fun isModified(): Boolean {
        return true
    }

    override fun getId(): String {
        return "preferences.CodeStreamConfigurable"
    }

    override fun getDisplayName(): String {
        return "CodeStream"
    }

    override fun apply() {
        val state = settingsService.state
        val gui = _gui
        gui?.let {
            state.autoSignIn = gui.autoSignIn.isSelected
            state.serverUrl = gui.serverUrl.text
            state.webAppUrl = gui.webAppUrl.text
            state.avatars = gui.showAvatars.isSelected
            state.muteAll = gui.muteAll.isSelected
            state.team = gui.team.text
            state.showFeedbackSmiley = gui.showFeedbackSmiley.isSelected
            state.showMarkers = gui.showMarkers.isSelected
            state.autoHideMarkers = gui.autoHideMarkers.isSelected
            state.proxySupport = gui.proxySupport.selectedItem as String
            state.proxyStrictSSL = gui.proxyStrictSSL.isSelected
            state.proxyUrl = gui.proxyUrl.text
        }
    }

    override fun createComponent(): JComponent? {
        val gui = CodeStreamConfigurableGUI()
        val state = settingsService.state

        gui.apply {
            autoSignIn.isSelected = state.autoSignIn
            serverUrl.text = state.serverUrl
            webAppUrl.text = state.webAppUrl
            showAvatars.isSelected = state.avatars
            muteAll.isSelected = state.muteAll
            team.text = state.team
            showFeedbackSmiley.isSelected = state.showFeedbackSmiley
            showMarkers.isSelected = state.showMarkers
            autoHideMarkers.isSelected = state.autoHideMarkers
            proxySupport.selectedItem = state.proxySupport
            proxyStrictSSL.isSelected = state.proxyStrictSSL
            proxyUrl.text = state.proxyUrl
        }

        _gui = gui
        return gui.rootPanel
    }

}